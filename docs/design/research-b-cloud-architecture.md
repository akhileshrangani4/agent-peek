# Research B — off-localhost / cloud-agent architecture options

**Date:** 2026-11-13 · **Repo:** `akhileshrangani4/agent-peek` @ `b6197fe` (v0.6.0, Node ≥ 24, `@modelcontextprotocol/sdk ^1.30.0`) · **Scope:** read-only research, no code changes.

**Evidence labels used throughout**

- **[R]** read in the repo this session (file:line given)
- **[F]** full page fetched this session on 2026-11-13 (URL in §8)
- **[S]** search-result snippet only, page not fetched (URL in §8)
- **[T]** training-data knowledge, not checked this session
- **[J]** my judgment or estimate
- **UNVERIFIED** means I looked and could not confirm it.

Vendor docs change quickly. Every vendor claim below is as of 2026-11-13.

> **Load-bearing assumption.** This brief assumes that making agent-peek reachable over the network is the missing piece that will let cloud agents coordinate. Three things would confirm it: in a pilot, agents in at least two cloud products reach the server under their default egress policy, call `read_feed` / `post_to_feed` without being told to, and measurably avoid duplicate exploration or conflicting edits. It breaks if agents do not call the tools unprompted, if customer egress policies block the endpoint, or if coordination already happens well enough through branches and PRs. **Check before committing beyond Phase 1:** run a two-product pilot (Claude Code cloud + Cursor are the cheapest, see §2) and measure tool-call rates.
>
> **Explanations the brief skipped.** (1) Cloud agents each work on an isolated clone and branch, so conflicts surface at PR time. Git and PR comments may already be the coordination channel, which would make a shared feed less valuable than it is locally. (2) Vendors already cover part of the visibility need: Cursor Cloud MCP lists related runs and fetches transcripts [F], and Devin exposes session messages over an API [F]. (3) The real value may be one human seeing every agent at once, which is a dashboard and ingestion problem, not agent-to-agent MCP.

---

## 0. Bottom line

- **Recommendation: Option D first, designed to become Option A.** Add a self-hostable `peek serve` mode to the existing npm package. It is a Node HTTP server that speaks MCP over **Streamable HTTP** plus a small REST ingest API, on single-node SQLite, with **per-project scoped bearer tokens**. Local-only stdio stays the default and is unchanged.
- **Before any server work, fix five portability problems in the local code (Phase 0).** Each one would produce wrong answers across machines:
  1. Feed cursors use the writer's wall clock.
  2. Claims sit in a single global file with no repo-relative normalisation.
  3. Authors are self-asserted.
  4. Drift is checked against local file mtime.
  5. The MCP feed defaults to the server's `cwd`.
- **Ingest structured status, not raw transcripts, by default.** Use agent-side hooks or a `peek push` CLI where they exist, and vendor pull APIs where they exist (Devin, Cursor). Raw transcript text only crosses the network under an explicit, separately scoped, opt-in grant. This extends the principle already in ADR 0001 [R].
- **Cost [J]:** about 5–8 engineer-weeks to a usable self-host (Phases 0–2), and a further 4–6 for OAuth plus hosted multi-tenancy.
- **What gets worse:** agent-peek takes on a network attack surface, an auth system, and custody of other agents' activity data. Users who opt in lose the "same-user, same-machine only" promise in the README [R].
- **What would reverse it:** see §6.

---

## 1. What in today's code is bound to localhost

agent-peek's own README states the current security model: "same-user, same-machine only… No remote transport is exposed… Access control is your local filesystem permissions" (`README.md:709-724`) [R]. Every row below must change, or be scoped as local-only, before the feed can be shared off one machine.

| Concern | Where [R] | Local binding today | Consequence off-machine |
|---|---|---|---|
| MCP transport | `src/mcp/index.ts:3,548` | `StdioServerTransport` only | Cloud agents whose MCP client only reaches remote URLs (Cursor's recommended HTTP mode, Copilot remote, Devin HTTP) cannot attach. A stdio server inside each sandbox would see only that sandbox. |
| Feed store | `src/feed/store.ts:26` | `~/.agent-peek/feed/<projectId>.db` via `node:sqlite` | Each machine or sandbox gets its own feed, so nothing is shared. |
| Project identity | `src/feed/identity.ts` `projectIdentity` | `sha256(normalizeRemote(origin))[:16]`. Falls back to the `git-common-dir` realpath, then the directory realpath | The remote-URL path is portable, which is good. Both fallbacks are machine-local, so the same repo without an `origin` gets different ids on each machine. The id is an unsalted hash of a guessable label, so it **must never act as an access secret**. |
| Author identity | `src/feed/identity.ts` `resolveAuthor`. MCP `post_to_feed.as` and `read_feed.reader` (`src/mcp/index.ts:96-131`) | `--as` override, then `CLAUDE_SESSION_ID`, then a single live local session in the same cwd, else `user@hostname` (anonymous) | Self-asserted and unauthenticated. Cloud hostnames are ephemeral, and only Claude has an env-var session id wired in. |
| Feed cursor | `src/feed/rank.ts:98`, `src/feed/index.ts:63-77` | base64url JSON `{watermark, seenDerived, seenStored}`. Posts with `createdAt <= watermark` are dropped | **Correctness bug once there are several writers.** A post written on a machine whose clock is behind, or replicated late, carries a `createdAt` older than the reader's watermark and is silently skipped. |
| Drift detection | `src/feed/index.ts:174` | `statSync(abs).mtimeMs > createdMs` | A server has no working tree. Mtimes are not comparable across clones (a fresh clone sets mtime = checkout time, so everything looks "drifted"). |
| Derived posts | `src/feed/derive.ts:27,92` | Status comes from locally discovered sessions. Overlap comes from local `git worktree` listings | Cloud agents are not local sessions, and their clones are not local worktrees. Status has to be *ingested*, and overlap has to be computed from pushed branches. |
| MCP defaults | `src/mcp/index.ts:102,375-376` | `dir` "defaults to server cwd". The `agent-peek://feed` resource calls `readFeed({ dir: process.cwd() })` | A remote server's cwd means nothing, so project must become an explicit parameter. |
| Claims | `src/core/claims.ts:22-25`, `src/core/types.ts:32-43` | One global `~/.agent-peek/claims.json` (not per project), guarded by `proper-lockfile`. `files` are stored as passed, plus the claimant's `cwd`. `owner` is free text | A file lock works on one host only. Paths are not normalised to the repo root, and nothing scopes a claim to a project, so two repos' `src/index.ts` collide. |
| Session cursor | `src/core/cursor.ts` | `{adapter, byteOffset, msgIndex, tail?}` | Byte offsets into a local transcript file mean nothing for a remote or ingested session. |
| Transcript sources | `src/adapters/*/index.ts` | `~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/tmp`, `~/.copilot/session-state`, `~/.local/share/opencode`, goose `sessions.db` | Cloud agents' transcripts live in their VMs or vendor backends, never on the user's disk. |
| Raw transcript exposure | `src/mcp/index.ts:25-50` (`peek_session`, `mode` default **`raw`**). Resource `agent-peek://session/{selector}/tail` | Full transcript messages returned to any local MCP caller | Over a network this is the largest exposure. ADR 0001 already concluded that transcript payloads hold "Bash command lines, absolute file paths, prompt text, and occasionally credentials" (`docs/adr/0001-…md`) [R]. |

**Contracts to preserve** [R]:

- **CLI:** the `peek …` commands.
- **MCP:** 12 tools (`peek_session`, `list_sessions`, `coordination_digest`, `tag_session`, `post_to_feed`, `read_feed`, `expand_post`, `usage_report`, `skills_report`, `skill_detail`, `archive_plan`, `list_agents`), 3 prompts (`coordinate-agents`, `session-handoff`, `avoid-overlap`) and the `agent-peek://` resources.
- **Library:** the exports in `src/index.ts`.

Every option below keeps stdio and the local store as the default, and adds remote behaviour behind explicit configuration.

---

## 2. How cloud agents can reach it

### 2.1 Integration-surface matrix (as of 2026-11-13)

| Product | Remote MCP transports | MCP auth | Token delivery into the agent | CLI or stdio inside the sandbox | Hooks | Default egress and controls | Vendor transcript API |
|---|---|---|---|---|---|---|---|
| **Claude Code cloud sessions** | HTTP "recommended… most widely supported transport for cloud-based services". SSE also documented [S: mcp] | Header such as `Authorization: Bearer` [S: hooks/mcp] | **Network secrets:** a proxy attaches the key after the request leaves the VM, so the "key itself stays outside the VM". Env vars, by contrast, can be read by "anyone who uses the environment" [F: cloud-environments] | Setup script plus pre-installed tools [F] | **Yes.** "The same hook events wherever it runs… and cloud sessions". Hook types: command, HTTP, MCP tool, prompt, agent [S: hooks] | Default env: "Limited network access: sessions reach package registries and other allowlisted domains". Custom levels exist [F] | None found (UNVERIFIED). `--teleport` moves a session to the terminal [S] |
| **OpenAI Codex Cloud (current)** | UNVERIFIED for cloud tasks. The fetched MCP page covers plugins and Sites hosting, not cloud-container MCP [F: codex/mcp] | UNVERIFIED | **HTTP secrets.** "Saving an HTTP secret also allows access to its domains". Env vars and OIDC also offered [F: codex/cloud, UI mock] | Install script, which the legacy docs say runs with internet [F: internet-access] | UNVERIFIED | Toggles: "Enable all public internet access", "package manager domains", "Additional allowed domains" [F] | None found. The CLI can "list recent cloud chats and check their status" [F] |
| **Codex Cloud (legacy)** | — | — | — | Setup scripts have internet [F] | — | **Internet blocked during the agent phase by default.** Domain allowlist plus optional **GET/HEAD/OPTIONS-only** method restriction [F] | — |
| **Cursor Cloud Agents** | **HTTP or stdio. "SSE and `mcp-remote` are not supported"** [F: capabilities]. The v1 API schema says remote servers support headers or OAuth [S: endpoints] | Headers. OAuth "per-user, including for MCP servers shared at the team level" [F] | **HTTP MCP config "never present in the cloud agent's VM… Tool calls are proxied through the backend"** [F]. Secret types are Environment Variable (visible), Runtime Secret (redacted from transcripts and commits) and Build Secret. **OIDC:** the agent "can mint a Cursor-signed JWT from a local socket" [F: security-network] | stdio servers run inside the VM [F] | UNVERIFIED | "Internet access by default". Modes: Allow all / Default + allowlist / Allowlist only [F] | **v0 `GET /v0/agents/{id}/conversation`** returns user and assistant messages [F: api/v0, marked legacy]. A forum post says v1 has no equivalent [S]. In-run **Cursor Cloud MCP** fetches transcripts, own runs only unless admin [F] |
| **GitHub Copilot cloud agent** | `type`: `local`, `stdio`, `http`, `sse` [F] | **Headers only.** "Do not currently support remote servers that use OAuth" [F] | `$COPILOT_MCP_*` Agents secrets substituted into `headers` and `env` [F] | Setup steps. The firewall "does not apply… to processes started in configured Copilot setup steps" [F] | UNVERIFIED | Firewall on by default with a recommended allowlist. Org and repo custom allowlists. The firewall covers the Bash tool and built-in Playwright, **"does not apply directly to other MCP servers"** [F] | Not researched (UNVERIFIED) |
| **Devin** | stdio, SSE, HTTP. "HTTP (Streamable HTTP) is recommended… SSE is supported for legacy servers" [F] | None / Auth Header / OAuth. Org-shared or personal connections [F]. Admin "header script" on shared servers [S: plugins] | Header value in the MCP config [F] | stdio via `npx`, `uvx` or Docker [F] | Customize page lists "hooks" alongside MCPs [F]. Semantics UNVERIFIED | UNVERIFIED | **v3 `GET /v3/organizations/{org_id}/sessions/{devin_id}/messages`** returns `{event_id, source: devin\|user, message, created_at, …}`, cursor-paginated, `cog_` service-user bearer [F] |
| **Obvious-style sandboxes** | No MCP-client configuration surface seen. Observed in this session's own platform instructions, not public docs | — | Secrets injected as `SECRET_<NAME>` env vars on shell commands (same source) | Full shell. The npm CLI can be installed | — | Shell has outbound network (same source) | — |

### 2.2 What this implies for the design

1. **Ship Streamable HTTP only, not SSE.** The current MCP spec lists exactly two standard transports, stdio and Streamable HTTP [F: spec transports]. Cursor rejects SSE for custom servers [F]. Devin and the Claude docs treat SSE as legacy [F][S].
2. **Static bearer header is the lowest common denominator, and it is mandatory.** Copilot cannot use OAuth remote servers [F]. All five products accept a header. OAuth 2.1 is worth adding later for Cursor, Devin and Claude interactive users. The spec requires the server to publish **Protected Resource Metadata (RFC 9728)** and lists Client ID Metadata Documents as the preferred registration path [S: MCP authorization 2026-07-28].
3. **Tools-only parity.** Copilot ignores MCP resources and prompts [F]. `agent-peek://feed` and session-tail resources, and the three prompts, are invisible there. Everything must be reachable as a tool. Today that is mostly true (`read_feed`, `peek_session` exist) [R].
4. **The server must sit on the public internet with TLS, or behind a vendor-reachable tunnel.** Cursor proxies HTTP MCP through its backend [F]. Claude network secrets require that "the API accepts connections from the internet, because requests leave from Anthropic's network" [F]. A laptop `localhost` will not work. A Cloudflare Tunnel public hostname would, and Cursor documents that pattern for private services [F]. OpenAI offers a "Secure MCP Tunnel" outbound client for private servers [S]. Whether Codex Cloud tasks use it is UNVERIFIED.
5. **Egress allowlisting is a setup step for every in-sandbox push.** This covers hook or CLI calls that POST status:
   - Claude's default env is allowlist-limited [F]. Adding a network secret for the host also makes it reachable [F].
   - Copilot needs a custom allowlist entry for Bash-tool traffic [F].
   - Cursor is open by default [F].
   - **Legacy Codex's GET-only mode would block every POST** [F]. Push ingestion is impossible there, and only MCP tool calls (if available) or vendor pull would work.
6. **Prefer token delivery the agent cannot read.** Claude network secrets, Codex HTTP secrets and Cursor HTTP-MCP headers keep the credential outside the VM [F]. A prompt-injected agent then cannot exfiltrate the agent-peek token. Env-var delivery (Copilot `COPILOT_MCP_*` for stdio, Cursor "Environment Variable", Obvious `SECRET_*`) leaves the token readable by the agent.
7. **Stateless requests suit serverless and horizontal scaling.** The current spec describes connection-scoped `initialize` sessions as an *earlier* revision's behaviour, with backward-compatibility fallback [F: spec transports]. Whether `@modelcontextprotocol/sdk ^1.30` implements the newest revision's stateless model is UNVERIFIED. That the TS SDK ships a Streamable HTTP server transport is [T].

---

## 3. Transcript ingestion off-machine

Locally, adapters read transcript files from disk [R]. For cloud agents those files sit in vendor VMs or backends. Five ingestion paths exist:

| # | Path | How | Fidelity | Coverage today | Privacy | Egress needs | Effort [J] |
|---|---|---|---|---|---|---|---|
| I1 | **Agent-side hooks push** | Claude Code `SessionStart` / `PostToolUse` / `Stop` hooks, as HTTP hook type or `peek push` command, POST compact events. Hooks fire in cloud sessions [S] | High: tool names, files, timing | Claude Code confirmed. Devin hooks exist, semantics unverified. Others UNVERIFIED | Good if the hook sends whitelisted fields only | POST to the server host must be allowed | S |
| I2 | **MCP publish tools the agent calls** | Existing `post_to_feed`, plus a new `publish_status` (current task, files being written, branch) | Medium: depends on the agent remembering, so skill or instruction files are needed | Every product with remote MCP (all except possibly Codex Cloud) | Best: agent-authored, bounded by schema (`AUTHORED_BODY_MAX_TOKENS`) [R] | None beyond MCP reachability (Cursor proxies [F]) | XS (tool exists) |
| I3 | **Vendor pull APIs** | Server-side connector polls Devin v3 messages [F] and Cursor v0 `/conversation` [F]. Cursor Cloud MCP is in-run only [F] | Devin: message text only, **no tool-call fields** in the schema [F]. Cursor v0: user and assistant text [F] | Devin, Cursor. Claude, Codex, Copilot: none found | Worst by default: pulls full conversation text, so it must be reduced server-side before storage | Server to vendor API only. No sandbox egress | M per vendor |
| I4 | **In-sandbox sidecar** | `peek agent` runs in the cloud VM, reuses the **existing adapters** against the VM's own `~/.claude/projects` or `~/.codex/sessions`, and ships *derived* status | High. Reuses tested parsers [R] | Products that run the same CLI inside the VM. That Claude cloud writes the same transcript layout in the VM is an inference (UNVERIFIED) | Good: reduction happens before data leaves the VM | POST allowed. A long-lived process must survive VM pause and resume [F: VMs pause when idle] | M |
| I5 | **Local daemon (multi-machine)** | On each human's laptop, `peek push --watch` ships derived status for local sessions to the shared server | High, same adapters | All 8 local adapters [R] | Good, same reduction | Laptop to server | S |

**Recommendation for ingestion.** Ship I2 and I5 first (small, no vendor dependency). Add the I1 Claude hook recipe next. Then build I3 for Devin and Cursor as server-side connectors.

**Make the derived `structured` / `brief` projection the wire format.** These fields already exist in the snapshot model: `currentTask`, `activity`, `writingFiles`, pending tools [R: `peek_session` mode descriptions]. Raw transcript text crosses the network only under a separate `sessions:raw` scope, with a short TTL and a redaction pass.

**Trade-off.** Cloud sessions become *lower-fidelity* than local ones (no `raw` / `handoff` modes by default). That is deliberate. It applies the ADR 0001 rule (store "named, whitelisted" fields, "never the raw `input` blob") to the network boundary [R].

---

## 4. Architecture options

### Option A — Hosted multi-tenant server (HTTP API + remote MCP); local CLI becomes a client

- **Shape.** One service per vendor deployment, Node and TypeScript reusing `src/feed/*`. It speaks Streamable HTTP MCP at `/mcp` and REST at `/v1/*`, on Postgres (or SQLite per tenant). The CLI gains `AGENT_PEEK_URL` / `peek login`. When it is unset, everything runs locally exactly as today.
- **Auth & tenancy.** Org → team → project (repo) → principals (human, device, agent token). Device-code login for the CLI [T: OAuth 2.0 device grant]. Per-project scoped tokens for cloud agents. OAuth 2.1 with PRM later [S].
- **Claims.** A server-side transaction gives compare-and-set on `(project, repo-relative path)`. Leases use the **server clock**. Contention returns the current holder.
- **Cursors.** A server-assigned monotonic `seq` per project replaces the `createdAt` watermark. Old local cursors still decode, because `decodeFeedCursor` already tolerates missing fields [R: `rank.ts:106`].
- **Offline.** The CLI keeps the local store. Posts made offline go to an outbox and replay with idempotency keys. Claims made offline are local-only and labelled "unconfirmed" until accepted by the server.
- **Ops cost.**
  - [T, unverified]: a small app host plus managed Postgres at low tens of US dollars a month.
  - [J]: the real cost is on-call, abuse handling, backups, a privacy policy, and being custodian of other companies' agent activity.
- **Migration.** `peek feed export | import` per project. Project ids are stable because they come from the remote URL [R].
- **Contracts.** Unchanged locally. MCP tools gain an optional `project` argument (additive). `dir` keeps working for local mode.
- **Verdict.** It is the right end state if agent-peek becomes a product with users outside the author's teams. It should not be the first step, because multi-tenancy and custody arrive before demand is proven.

### Option B — Sync layer replicating the local store (libSQL/Turso replicas, log shipping, CRDT)

- **Shape.** The local SQLite stays the read path, replicated to a remote primary.
- **What the retrieved docs say about Turso embedded replicas** [F]:
  - Reads are always local. Writes go to the remote primary by default and are "NOT written to the local file first" unless `offline: true`.
  - Read-your-writes holds for the writing replica. Others see changes on `sync()` or a `syncInterval`.
  - Replication is page-level: "One frame equals 4kB… a 1 byte row… will always show up as a 4kB write".
  - "Do not open the local database while the embedded replica is syncing. This can lead to data corruption."
  - Not usable "in serverless environments without a filesystem".
  - Turso now recommends the newer **Turso Sync** (CDC-based, explicit `push()` / `pull()`) for new projects [F].
- **Auth & tenancy.** Coarse. A replica authenticates with a database token, so every sandbox holding it can read the whole project DB. Agent identity is not enforced, and there is no row-level scoping [J].
- **Claims.** Fine online, because writes go to the primary. With `offline: true` or CRDT merges, two agents can both "win" a claim. **Mutual exclusion is not a commutative operation, so a CRDT cannot give exclusive claims** [J]. Posts (append-only) replicate fine.
- **Cursors.** Replication lag breaks today's `createdAt` watermark (late arrivals are skipped, see §1), so `seq` is needed anyway.
- **Offline.** Best of all options for posts.
- **Ops cost.** A managed DB vendor. Turso pricing was not retrieved (UNVERIFIED).
- **Migration.** Swap `node:sqlite` for `@libsql/client` [T], and handle the "don't open while syncing" constraint against the CLI and MCP processes sharing the file [F][R].
- **Contracts.** Preserved locally. **But it gives cloud agents no endpoint.** Cursor's recommended HTTP MCP and Copilot remote need a URL, so a server is still required.
- **Verdict.** It solves "one human, several laptops". It does not solve cloud agents. Keep it as an option for offline-heavy users, not as the backbone.

### Option C — Serverless/edge (Cloudflare Workers + SQLite-backed Durable Objects, or D1)

- **Shape.** A Worker terminates MCP and REST and routes to **one Durable Object per project**. Each DO has private SQLite storage that is "transactional and strongly consistent" [S: DO storage API]. Each object is "inherently single-threaded" [F: limits FAQ].
- **Claims and cursors.** This is the strongest point. A single-threaded object per project serialises every claim and post, so CAS is trivial and a DO-local `seq` is the cursor [J built on F].
- **Limits** [F]:
  - 10 GB per object.
  - Soft cap of 1,000 req/s per object.
  - 30 s default CPU per request, configurable to 5 min.
  - 100 bound parameters per query, 100 KB statement length.
  - 8 MB max row.
  - These are not binding for a feed.
- **Ops cost** [F unless marked]:
  - Workers Paid has a $5/month account minimum [S].
  - DO requests: 1M/month included, then $0.15 per million.
  - Duration: 400k GB-s included, then $12.50 per million GB-s, and only while not hibernatable.
  - SQLite: 25B rows read and 50M rows written included per month (then $0.001 / $1.00 per million). Storage: 5 GB-month included, then $0.20 per GB-month.
  - *Worked example [J]:* 50 agent sessions a day × 25 MCP calls ≈ 37.5k requests a month. At about 50 ms active time × 128 MB that is roughly 235 GB-s, so it fits inside the included allotments and the bill is the $5 floor.
- **Auth & tenancy.** Implemented in the Worker (tokens in KV or the DO). OAuth helpers for MCP on Workers exist [T: Cloudflare Agents SDK / `McpAgent`, unverified this session].
- **Offline.** Same outbox design as A.
- **Migration and contracts.** The storage layer must be rewritten to the DO SQL API. `src/feed/rank.ts` / `schema.ts` pure logic ports. `engine`, adapters, `git` (`child_process`) and `fs` drift checks do not run in Workers [R for usage, T for runtime limits]. A second runtime target must stay in sync. Self-hosting is harder [T: `workerd` exists].
- **Verdict.** It is the cheapest and lowest-ops *managed* option, with the best consistency story for claims. The costs are vendor lock-in and a split codebase. It is the right pick if the goal is a SaaS rather than an OSS tool teams run themselves.

### Option D — Self-hostable single process / Docker (`peek serve`)

- **Shape.** The same npm package adds `peek serve --port --data-dir`. It is a Node HTTP server exposing Streamable HTTP MCP and REST over the **existing** `node:sqlite` feed store, with a per-project DB as today [R]. Shipped as `npx agent-peek serve` and a Docker image. The team runs it on any VM or PaaS, fronted by TLS (Caddy, a Cloudflare Tunnel public hostname [F: Cursor's pattern], Fly, and so on).
- **Auth & tenancy.** Single tenant (one team). Admin-minted tokens `{project(s), scopes, label, expiry}` stored hashed. No user database at first.
- **Claims.** One process gives one serialisation point. A SQLite transaction (`BEGIN IMMEDIATE`) replaces `proper-lockfile` [J]. Leases use the server clock.
- **Cursors.** SQLite `rowid` / `seq`.
- **Offline.** Same as A: the client outbox degrades to local-only.
- **Ops cost.** Zero for the maintainer. The user pays for a small VM [T: single-digit to low-tens of USD a month] and a tunnel (free tier [T]). Backups are one SQLite file (`VACUUM INTO`) [T].
- **Migration.** Trivial. Copy `~/.agent-peek/feed/<id>.db` into the server's data dir, since the schema is identical [R].
- **Contracts.** Maximal reuse. MCP tool definitions are shared between the stdio and HTTP transports, so the remote tool list is the local list minus the transcript tools that cannot work remotely, plus `project`.
- **Verdict.** It is the fastest path to a working cross-machine, cross-vendor feed. It keeps data under the team's control, matches the project's OSS/MIT shape, and builds the exact server that A would later host.

### 4.1 Comparison

| | A Hosted | B Sync | C Edge (DO) | D Self-host |
|---|---|---|---|---|
| Reachable by cloud agents | ✅ | ❌ (no endpoint) | ✅ | ✅ (needs public TLS) |
| Exclusive claims | ✅ server CAS | ⚠️ online only | ✅ single-threaded object | ✅ single process |
| Correct cursors | ✅ with `seq` | ⚠️ needs `seq`, lag | ✅ DO `seq` | ✅ `rowid` |
| Offline | outbox | ✅ best | outbox | outbox |
| Per-agent auth / scoping | ✅ | ❌ DB-token-level | ✅ | ✅ (single tenant) |
| Code reuse | high | high (driver swap) | low–medium (runtime split) | **highest** |
| Ops for maintainer | high | medium | low | **none** |
| Monthly floor | [T] tens of $ | UNVERIFIED | $5 [S] | user's VM |
| Effort to first use [J] | 6–10 wk | 3–4 wk (laptops only) | 5–8 wk | **4–6 wk** |

---

## 5. Identity & security

### 5.1 Principals and tenancy

There are four kinds of principal, each scoped to the one below:

1. **Org/team.** In D this is implicit: one deployment.
2. **Project.** The normalised remote label, such as `gh:owner/repo` [R: `normalizeRemote`].
3. **Token.** Bound to projects and scopes.
4. **Session.** The agent run that is using a token.

Authorisation always checks token → project grant. **The 16-hex project id is an unsalted hash of a public URL** [R], so it is an identifier, never a secret.

### 5.2 Agent/session identity across machines

- **Split identity into two fields.**
  - *Authenticated principal:* the token's label, e.g. `cursor-cloud@team`, or a verified OIDC subject.
  - *Asserted session label:* today's `as`, `reader` and `CLAUDE_SESSION_ID`.
  - Store both. Display the label, but authorise and attribute on the principal.
  - Today's `as` / `--as` stays as a display alias only [R: `resolveAuthor`, `post_to_feed.as`].
- **Use vendor run identity where it can be verified.**
  - Cursor's OIDC JWT minted inside the VM [F]. Exchanging it for a short-lived agent-peek token is the design [J].
  - Devin's admin header script, for short-lived credentials [S].
  - Claude `CLAUDE_SESSION_ID` is already used locally [R]. Whether it is set in cloud sessions is UNVERIFIED.
- **Drop `user@hostname` for remote writes.** Cloud hostnames are ephemeral, so anonymous remote posts should be refused, or labelled by token.

### 5.3 Repo identity

- **Remote mode keys on the normalised remote URL.** This is today's primary path [R].
- **Refuse remote mode when there is no `origin`**, or require an explicit `--project <name>`. The path-hash fallbacks are machine-local [R].
- **Forks, mirrors and host renames** produce different labels. Add server-side aliases, not client heuristics.
- **Claims and post paths must be repo-relative** to `git rev-parse --show-toplevel`. Posts already document "Repo-relative paths" [R]. Claims do not normalise [R].
- **Drift checks move client-side.** Record the git blob hash of each evidence path at post time. Each reader compares against its own checkout instead of mtime [J].

### 5.4 Token scoping and delivery

- **Scopes:** `feed:read`, `feed:write`, `claims:write`, `status:write` (ingest), `sessions:read` (structured/brief), and a separate `sessions:raw` that is off by default.
- **Tokens:** short expiries, revocable, stored hashed.
- **Delivery per product, preferring options the agent cannot read** (§2.2 point 6):
  - Claude: network secret [F].
  - Codex: HTTP secret [F].
  - Cursor: HTTP MCP header [F] or OIDC exchange.
  - Copilot: `$COPILOT_MCP_*` header [F].
  - Devin: auth header or OAuth [F].
  - Obvious: `SECRET_*` env.

### 5.5 Secret/PII exposure of transcripts

- `peek_session` defaults to `mode: raw` [R]. Remote surfaces must default to `structured` / `brief` and never return `raw` / `tail` / `handoff` material without `sessions:raw`.
- **Redact before upload.** Ingestion clients run a secret-pattern pass (common token formats) before sending anything [T: tools such as gitleaks publish such patterns]. Vendor redaction (Cursor Runtime Secrets are replaced with `[REDACTED]` in transcripts [F]) does not cover data that agent-peek pulls or pushes itself.
- **Pulled vendor transcripts carry their own warning.** Cursor's own doc says agent conversations "can include prompts, code, tool output, and secrets" [F]. Reduce them to whitelisted fields at the connector, and never persist the raw text.

### 5.6 Cross-agent prompt injection

The feed is an agent-to-agent channel. A post from one agent becomes context for another, and cloud agents auto-run commands:

- Cursor: "auto-runs all terminal commands… data exfiltration risk" [F].
- Codex legacy docs show an exfiltration walk-through [F].
- Copilot uses MCP tools "autonomously… without approval" [F].

Mitigations:

- Tool results should present posts as quoted data with author provenance (`principal` vs asserted label).
- Keep `expand_post`'s "before trusting or acting on it" framing [R].
- Rate-limit writes per token.
- Cap body size. Authored bodies are already token-capped [R].

### 5.7 Data retention

- **Keep today's per-type TTLs** [R: README "expire per-type on a TTL"] and enforce them with a server-side hard-delete job, not just a `validity='expired'` flag [R: `store.ts:155`].
- **Derived or ingested session data never outlives its source policy.** References: Claude local transcripts are deleted after 30 days per ADR 0001's context [R]. Cursor conversation history is indefinite by default, with a 90-day option for some Enterprise teams [F].
- **Per-project retention override and full-project delete** (right to erase).

---

## 6. Recommendation

**Build D on a portable core, keep local-only as the default, and ingest structured status rather than transcripts.**

| Phase | Scope | Effort [J] |
|---|---|---|
| **P0 – portability (local behaviour unchanged)** | Server-assigned `seq` cursors (legacy cursors still decode) · explicit `project` parameter alongside `dir` · per-project, repo-relative claims in SQLite, not global JSON · principal-vs-label author split · blob-hash drift | 1–2 wk |
| **P1 – `peek serve`** | Streamable HTTP MCP sharing tool definitions with stdio · REST ingest · hashed scoped tokens · Dockerfile · remote tool set excludes raw transcript modes | 2–3 wk |
| **P2 – clients & ingestion** | CLI remote mode with outbox · `peek push` (laptop daemon, I5) · `publish_status` tool (I2) · Claude hook recipe (I1) · setup docs per vendor from §2.1 | 2–3 wk |
| **P3 – later, only on demand** | OAuth 2.1 + PRM · Devin and Cursor pull connectors (I3) · hosted multi-tenant (A) or DO port (C) | 4–6 wk |

**What improves.** Cloud agents in Claude Code, Cursor, Copilot and Devin can share one feed and claims. Multiple machines converge. The local contract is untouched. Data stays with the team running the server.

**What gets worse.**

- A network attack surface and an auth system to maintain.
- Users who opt in lose the "same-machine only" guarantee.
- Each vendor needs manual setup: an allowlist entry plus a secret.
- Cloud sessions are lower-fidelity than local ones by design.
- Codex Cloud remains uncertain (§7).

**What would reverse this call.**

1. **If the goal is a managed SaaS for many teams** rather than an OSS tool teams self-run → choose **C** (one DO per project gives free serialisation and a $5 floor). Move to **A** on Postgres only if cross-project queries or the graph work need a central database.
2. **If the pilot shows agents rarely call the feed tools unprompted** → the bottleneck is agent behaviour, not transport. Put P1–P2 on hold and invest in instructions and skills, plus hook-driven automatic posting.
3. **If the dominant need turns out to be one human across laptops with no cloud agents** → **B** with Turso Sync is cheaper than running a server.
4. **If target customers' egress policies cannot allow a third-party host** (Copilot org firewall locked, legacy Codex GET-only) → favour vendor pull (I3) aggregated server-side over in-sandbox push.

---

## 7. Open questions / unverified

- Codex Cloud (current): can cloud tasks use remote MCP servers, are hooks available, and does Secure MCP Tunnel apply? Not confirmed in the fetched pages.
- Claude Code cloud: is `CLAUDE_SESSION_ID` set in cloud VMs, do transcripts land at `~/.claude/projects` inside the VM, and is there any transcript API?
- Copilot cloud agent: session-log API, hooks, and whether `COPILOT_MCP_*` values are visible to the Bash tool.
- Devin: hook semantics and egress controls.
- Cursor: a v1 conversation and stream endpoint is suggested only by forum posts [S], not official docs.
- `@modelcontextprotocol/sdk ^1.30`: does it support the 2026-07-28 spec's stateless model, or only the earlier session model?
- Turso and D1 pricing were not retrieved.
- Overlap derivation from pushed branches needs a design (GitHub compare API vs `git ls-remote` + fetch).

---

## 8. Sources (all retrieved 2026-11-13)

| URL | Kind | What it showed |
|---|---|---|
| https://code.claude.com/docs/en/cloud-environments | [F] | Default env "Limited network access… allowlisted domains". Env vars readable by anyone using the env. Network secrets attached by the agent proxy, key stays outside the VM, API must accept internet connections, not sent on setup-script requests or to package registries. Self-hosted envs have no network secrets. VMs pause when idle. |
| https://code.claude.com/docs/en/hooks | [S] | Hook types: command, HTTP, MCP tool, prompt, subagent. "Fires the same hook events wherever it runs… and cloud sessions". HTTP hook `headers` + `allowedEnvVars` example. |
| https://code.claude.com/docs/en/mcp | [S] | "HTTP servers are the recommended option for connecting to remote MCP servers." |
| https://code.claude.com/docs/en/claude-code-on-the-web | [S] | Cloud sessions. Move sessions with `--cloud` and `--teleport`. |
| https://developers.openai.com/codex/cloud | [F] | Environment settings UI: public internet toggle, package manager domains, additional allowed domains, HTTP secrets ("also allows access to its domains"), env vars, OIDC, VPN. CLI lists cloud chats. |
| https://developers.openai.com/codex/mcp | [F] | Plugins / Sites-hosted MCP. No cloud-container MCP statement. |
| https://developers.openai.com/codex/cloud/internet-access | [F] | *Legacy* Codex Cloud: agent internet blocked by default. Setup scripts have internet. Allowlist presets. GET/HEAD/OPTIONS-only option. Prompt-injection exfiltration example. |
| https://developers.openai.com/api/docs/guides/tools-connectors-mcp | [S] | Secure MCP Tunnel for private servers. |
| https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers | [F] | Types local/stdio/http/sse. Tools only, no resources or prompts. No OAuth remote servers. `COPILOT_MCP_` secrets in `headers` / `env`. Autonomous tool use. |
| https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-the-firewall | [F] | Firewall on by default with a recommended allowlist. Org/repo custom allowlists. Applies to Bash tool and built-in Playwright, not other MCP servers or setup steps. |
| https://cursor.com/docs/cloud-agent/capabilities | [F] | Custom MCP: HTTP or stdio, "SSE and mcp-remote are not supported". HTTP config never in VM, tool calls proxied via backend. Per-user OAuth. Cursor Cloud MCP: transcripts, related runs, egress policy, admin vs own-run access. |
| https://cursor.com/docs/cloud-agent/security-network | [F] | Env Variable / Runtime Secret (redacted) / Build Secret. OIDC Cursor-signed JWT. Internet on by default. Three egress modes. Auto-run exfiltration risk. Conversation history indefinite by default, 90-day option. Cloudflare Tunnel / Tailscale patterns. |
| https://cursor.com/docs/cloud-agent/api/v0 | [F] | Legacy v0. `GET /v0/agents/{id}/conversation` (user/assistant messages). "MCP… not yet supported by the Cloud Agents API" (v0). |
| https://cursor.com/docs/cloud-agent/api/endpoints | [S] | v1 public beta. Inline `mcpServers`, remote servers support headers or OAuth. |
| https://forum.cursor.com/t/cloud-agents-freeze-mid-run-and-never-reach-a-terminal-state-60-consecutive-account-wide-since-18-aug/168957 | [S] | Forum: `/v0/agents/{id}/conversation` "has no v1 equivalent". |
| https://forum.cursor.com/t/feature-request-cloud-agents-api-live-activity-stream-stable-events-and-run-summary-for-third-party-chat-uis/167711/6 | [S] | Forum: v1 `GET /v1/agents/{id}/runs/{runId}/stream` SSE with `tool_call` events (unofficial). |
| https://docs.devin.ai/work-with-devin/mcp | [F] | stdio/SSE/HTTP, Streamable HTTP recommended. Auth: None/Auth Header/OAuth. Org-shared vs personal connections. Customize page lists hooks. |
| https://docs.devin.ai/product-guides/plugins | [S] | Admin can set a header script on a shared MCP server. |
| https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session-messages | [F] | `GET /v3/organizations/{org_id}/sessions/{devin_id}/messages`. Fields `event_id, source (devin\|user), message, created_at, origin, user_id, username`. `cog_` bearer. View permissions. |
| https://modelcontextprotocol.io/specification/latest/basic/transports | [F] | Standard transports: stdio, Streamable HTTP. Earlier revisions used connection-scoped `initialize` sessions, with backward-compat fallback. |
| https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization (+ /authorization-server-discovery, /client-registration) | [S] | OAuth 2.1 subset. Servers MUST implement RFC 9728 PRM. Registration priority incl. Client ID Metadata Documents; DCR for back-compat. |
| https://docs.turso.tech/features/embedded-replicas/introduction | [F] | Local reads, writes to remote primary unless `offline`. Read-your-writes. `syncInterval`. 4 kB frames. Don't open during sync. No serverless without FS. Turso Sync recommended for new projects. |
| https://developers.cloudflare.com/durable-objects/platform/pricing/ | [F] | Request, duration and SQLite row/storage pricing and included tiers (quoted in §4 C). |
| https://developers.cloudflare.com/durable-objects/platform/limits/ | [F] | 10 GB per object, ~1,000 req/s soft per object, single-threaded, CPU limits, SQL limits. |
| https://developers.cloudflare.com/workers/platform/pricing/ | [S] | Workers Paid minimum $5/month per account. |
| https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ | [S] | DO storage is transactional, strongly consistent, private per object. |
| Repo files cited as [R] | [R] | `README.md`, `docs/adr/0001-usage-index-stores-whitelisted-arguments.md`, `src/mcp/index.ts`, `src/feed/{identity,store,index,rank,derive,schema}.ts`, `src/core/{claims,cursor,types}.ts`, `src/adapters/*/index.ts`, `package.json` at `b6197fe`. |
