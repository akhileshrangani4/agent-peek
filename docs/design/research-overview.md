# Research — agent-peek overhaul: off-localhost, cloud agents, conversation knowledge graph

**Repo:** `akhileshrangani4/agent-peek` @ `main` `b6197fe` (v0.6.0) · **Date:** 2026-11-13 · **Stage:** Research (read-only; no code, branch or PR)

This is the consolidated research document the spec consumes. It synthesizes three detailed findings documents, which hold the file:line evidence and the cited web sources:

- **Research A** — codebase map, data stores, localhost coupling, tests ([research-a-codebase-map.md](research-a-codebase-map.md))
- **Research B** — off-localhost / cloud-agent architecture options ([research-b-cloud-architecture.md](research-b-cloud-architecture.md))
- **Research C** — graph DB & conversation knowledge-graph options ([research-c-graph-db.md](research-c-graph-db.md))

Every claim below is restated from those documents. Where a claim was inferred from code or comes from training data rather than retrieval, the source document marks it; I keep that label here.

**Repo assumption.** The request ("overhaul the entire project", "get it off localhost", "work across cloud agents", "graph DB with all the convos") was mapped to agent-peek, the only workspace repo whose core job is reading agent conversations on one machine. heel and teachanything were not researched.

---

## 0. Bottom line

1. **agent-peek is pull-only and single-machine by construction.** No module opens a socket; MCP is stdio-only; `peek ui` is a TTY app; every adapter walks `$HOME`; all state lives in `~/.agent-peek` (A §4). Getting off localhost is not a transport swap — the data flow has to reverse so remote agents *push* into a store.
2. **The code is healthy enough to build on.** Under Node 24: typecheck clean, lint 0/0, 573 tests pass in 43 files, line coverage 90.56% (A §7). The weak spots are `core/claims.ts` (4.41% lines) and a 2,455-line CLI that holds business rules and is excluded from coverage.
3. **Identity is the real blocker, for both goals.** Sessions are keyed by local `transcriptPath`; claims store absolute paths; authors fall back to `user@hostname`; feed cursors watermark on the writer's wall clock (A §4, B §1). Every later layer — server, sync, graph — joins on these keys, so they get fixed first.
4. **Recommended shape:** a portability phase (no behaviour change locally) → a self-hostable `peek serve` (Streamable HTTP MCP + REST ingest + SQLite + project-scoped bearer tokens) with local stdio still the default → a knowledge graph stored as typed `node`/`edge` tables in `node:sqlite`, the same schema running inside `peek serve`, Postgres + pgvector only if hosted multi-tenancy is built (B §6, C §6).
5. **No dedicated graph database yet.** Every target query is ≤ 2 hops plus filters/time, except the subagent tree (shallow recursion). Relational edge tables with FTS5 and recursive CTEs serve that, add no runtime dependency, and keep one dialect through the self-host stage (C §5–6).
6. **Privacy is the harder decision than the store.** ADR 0001 forbids storing raw tool input in the usage index. A graph that "holds all conversations" collides with that principle. The default design stores structure, pointers and authored/derived short text; transcript text stays local and opt-in (B §3, C §4). This needs an owner decision and its own ADR.

> **Load-bearing assumption.** The overhaul assumes that (a) cloud agents can be made to send their activity to an agent-peek endpoint, and (b) once they can, they will actually use the shared feed/graph so that duplicate exploration and conflicting edits measurably drop. Confirm (a) per harness before building a push path (B §2 found Streamable HTTP is the one transport they share, but Codex Cloud remote MCP is unverified and legacy Codex can be GET-only). Confirm (b) with a two-product pilot (Claude Code cloud + Cursor are cheapest) that counts unprompted `read_feed`/`post_to_feed` calls. For the graph, the assumption is that agents' questions need a graph at all; log query shapes for 2–4 weeks and count ≥3-hop traversals before paying for a graph server.
>
> **Explanations the brief skipped.** Cloud agents work on isolated clones, so git branches and PR comments may already be the coordination channel. Vendors already cover part of the visibility need (Cursor Cloud MCP lists runs and transcripts; Devin exposes session messages over API). The real value may be one human seeing every agent — a dashboard/ingestion problem, not agent-to-agent MCP. And for knowledge, extraction quality and retention policy matter more than which database holds it.

---

## 1. Codebase map (from A §1–3)

agent-peek is "context feed and read-only visibility for local AI coding agents." Six capability families: session observation (`list`, `at`, `ui`), coordination (`coord`, `check`, `claim`, `release`), context feed (`post`, `feed`, `expand`), handoff (`at --mode handoff`), usage analytics (`usage`), skills/agents inventory (`skills`, `agents`). Surfaces: 22 CLI commands, an MCP server with 12 tools / 3 prompts / 2 resources / 3 resource templates, and a TS library with three export subpaths.

| Module | Size | Owns |
|---|---|---|
| `src/core` | 2,881 lines | `Engine` (list/peek/coordinate), `Registry` (`registry.json`), `ClaimsStore` (`claims.json`), cursor codec, snapshot modes, coordination digest, handoff |
| `src/adapters` | 1,833 lines | `Adapter` contract (`scan`, `read`; `watch?` reserved/unused), 8 adapters, external adapter loader (`AGENT_PEEK_ADAPTER_PATH`) |
| `src/feed` | 867 lines | Typed posts, per-project SQLite store, project/author identity, derived status posts, rank-and-pack |
| `src/usage` | 1,407 lines | Durable invocation index with watermarks; ADR 0001 whitelist |
| `src/skills` | 1,613 lines | Skill inventory, resolution, archive |
| `src/agents` | 1,197 lines | Agent catalog (leaf module) |
| `src/cli` | 4,388 lines | `cac` command tree (`index.ts` 2,455 lines, holds identity and claim-path rules), Ink TUIs |
| `src/mcp` | 1,019 lines | stdio MCP server |

**Layering leaks:** a core↔adapters type cycle; `skills` imports `feed/schema`; CLI renderer exported as library API; `UsageStore.handle()` exposes the raw DB. Both front-ends wire stores directly with no application-service layer, so an HTTP front-end would have to duplicate CLI-resident logic unless it is extracted.

**Stores:**

| Store | Engine | Location | Note |
|---|---|---|---|
| Session registry | JSON + lockfile | `~/.agent-peek/registry.json` | Rewritten under lock on every `list()`; historically 1,131 of 1,749 entries stale |
| File claims | JSON + lockfile | `~/.agent-peek/claims.json` | Absolute paths; one global file |
| Feed | `node:sqlite` WAL | `~/.agent-peek/feed/<projectId>.db` | No schema version, no migrations; only `posts_created` and `post_paths_path` indexes |
| Usage index | `node:sqlite` WAL | `~/.agent-peek/usage.db` | `SCHEMA_VERSION=1`, additive-only migrations, watermarks — the template to copy |
| Agents, skills archive | JSON / dirs | `~/.agent-peek/…` | No lock |

**Normalized shape:** `SessionEntry` (id, adapter, `transcriptPath`, cwd, status, `parentSessionId`…) and `RawMessage` (role, text, `toolCalls`, timestamp, `raw`). Messages have no stable id beyond `(sessionId, msgIndex)`; tool-call `id` is optional and dropped entirely by the Codex parser.

**Adapters:** claude-code and codex (JSONL, byte-offset incremental), gemini/opencode/goose/copilot-cli (re-read and re-parse whole sessions each read; cursors only slice), tmux/screen (scrollback capture). Goose shells out to the `sqlite3` CLI with string-built SQL.

---

## 2. Constraints the change must respect (A §8, B §5, C §4)

1. **Runtime/toolchain:** Node ≥ 24 (bin shims exit 5 below it), ESM, tsup, TypeScript ~5.9, Vitest, oxlint; CI on Node 24 runs `npm ci → lint → typecheck → build → coverage` with thresholds 85/84/80/70. Releases appear to be manual (inference).
2. **CLI contract:** 22 commands under `peek`/`apeek`, `--json` output and JSON error records, exit codes 1 (check conflicts), 5 (invalid usage / old Node / no TTY), 6 (environment error) — asserted by integration tests.
3. **MCP contract:** the 12 tool names and argument schemas, 3 prompts, resources `agent-peek://sessions|feed` and the `session/{selector}/brief|handoff|tail` templates. Clients hard-code these.
4. **Library contract:** everything exported from `src/index.ts`, including storage classes and path helpers; `./adapter` is a third-party plugin ABI.
5. **Cursor strings** are persisted by clients; encoding changes must fail cleanly via the existing `InvalidCursorError`/`CursorMismatchError`.
6. **On-disk state:** `~/.agent-peek` layout is a contract; `usage.db` changes additively only, because expired transcripts can't be re-derived.
7. **ADR 0001:** usage index stores whitelisted arguments, never raw input. A store holding transcript text is a new retention decision → new ADR.
8. **Bundled agent skill** (`skills/agent-peek/SKILL.md` + evals) teaches agents the CLI; renames break learned behaviour.
9. **Security promise:** "same-user, same-machine only" (README, security docs). Any remote mode must be opt-in and documented as changing that promise. The security page is already inaccurate about which stores peek writes.
10. **Local stays first-class:** the user wants cloud *in addition to* local workflows; stdio MCP and offline use must keep working unchanged.

---

## 3. Localhost coupling — what breaks off-machine (A §4, condensed)

| Coupling | Breaks for a remote/cloud agent |
|---|---|
| Transcript discovery walks local `$HOME` (all 6 file adapters); ignores `CLAUDE_CONFIG_DIR`/`CODEX_HOME` | Cloud transcripts live in vendor VMs; relocated config dirs are invisible |
| All state in `~/.agent-peek`; file locks + atomic rename + WAL | Each host has a private registry/claims/feed; ephemeral sandboxes lose state at teardown |
| Session identity = adapter + native id, keyed by `transcriptPath` | No host/tenant dimension; Goose sessions share one `transcriptPath`, Copilot uses a directory → watermark collisions (inference) |
| Author fallback `user@hostname` | Cloud containers become anonymous, unstable authors |
| Claims store absolute paths | `/home/a/repo/x.ts` ≠ `/workspace/repo/x.ts`; cross-machine conflicts undetected |
| Coordination drops paths not on the reader's disk | Remote writes vanish from the digest |
| Drift = local mtime vs post `createdAt` | Remote reader's mtimes are unrelated; clocks mixed |
| Feed cursor watermarks writer `createdAt` | Clock skew hides or duplicates posts |
| Liveness from transcript mtime | Synced copies get fresh mtimes |
| Peek cursor carries adapter but not session/host | A cursor decodes against the wrong session (inference) |
| MCP stdio only; defaults use server `process.cwd()` | Cloud agents can't attach; a server has no meaningful cwd |
| Security = OS file permissions; `peek_session mode=raw` returns transcript text | Off-box needs auth, tenancy and a transcript exposure policy |
| Handoff harness spawns a local CLI with `process.env` | Server-side would run an agent CLI under server credentials |

Already portable: git-remote project id, repo-relative paths on feed posts, typed post links, MCP handoff `material` mode, the usage index's whitelist.

---

## 4. Performance and indexing debt (A §5)

- `Engine.list()` rescans every adapter and rewrites `registry.json` under lock on **every read**; `peek()` calls `list()` first.
- Coordination re-reads a changed session from byte 0 after a delta read; Codex rollouts can be tens of MB.
- Feed `candidates()` filters on `validity`, `expires_at`, `type` with no indexes and runs a lazy-expiry `UPDATE` on every read; `checkDrift` stats every path on every read.
- Derived status posts call `list()` then `peek()` per live session → N+1 full adapter scans per feed read (inference).
- Usage index lacks indexes on `adapter`, `session_id`, `cwd`, `agent`; `allInvocations()` scans the table.
- The usage scan pattern (size+mtime skip, deterministic PK, per-source transaction, additive migrations) is the one to generalize.

---

## 5. Overhaul candidates (A §6, ranked by how much they block the goals)

1. Reads write state (registry rewrite on `list()`).
2. Coordination double-read.
3. Session identity tied to `transcriptPath`.
4. Codex parser drops `call_id`; only Claude Code settles tool statuses → tool call ↔ result join missing.
5. Duplicated JSONL slicing (claude-code vs codex).
6. Cursor fields mean different things per adapter.
7. Two ways into SQLite (`node:sqlite` vs `sqlite3` CLI with string-built SQL).
8. Leaky layers (see §1).
9. 2,455-line CLI holding logic; excluded from coverage.
10. Feed DB has no schema version.
11. Inconsistent `HOME`/env resolution.
12. Polling only; `watch?` reserved but unused — no event seam for push.
13. Security docs drift.
14. Test gaps — claims at 4.41% lines; multi-session Goose untested.

These group naturally into: **(i) identity & portability**, **(ii) an application-service layer extracted from the CLI** so CLI, stdio MCP and HTTP share one implementation, **(iii) storage hygiene** (versioned feed schema, SQLite-backed claims and registry, indexes), **(iv) adapter correctness** (shared JSONL reader, Codex `call_id`, unified cursor meaning, drop the `sqlite3` CLI).

---

## 6. Options considered

### 6.1 Off-localhost architecture (B §4)

| | A Hosted multi-tenant | B Sync layer (Turso replicas) | C Edge (Cloudflare Workers + Durable Objects) | **D Self-host `peek serve`** |
|---|---|---|---|---|
| Reachable by cloud agents | ✅ | ❌ no endpoint | ✅ | ✅ (needs public TLS) |
| Exclusive claims | ✅ | ⚠️ online only | ✅ | ✅ |
| Correct cursors | ✅ with `seq` | ⚠️ lag | ✅ | ✅ `rowid` |
| Per-agent auth/scoping | ✅ | ❌ | ✅ | ✅ single tenant |
| Code reuse | high | high | low–medium | **highest** |
| Maintainer ops | high | medium | low | **none** |
| Monthly floor | tens of $ (training data) | unverified | $5 (snippet) | user's VM |
| Effort to first use (estimate) | 6–10 wk | 3–4 wk (laptops only) | 5–8 wk | **4–6 wk** |

**Chosen: D, built on a portable core so it can become A.** It reuses the most code, adds no service the maintainer must run, keeps data with the team that runs it, and reaches every cloud product that supports remote MCP. B is rejected because cloud agents can't reach it; C splits the runtime and fits a managed SaaS, which nobody has asked for yet; A is the destination if hosting for others becomes the goal.

**Integration-surface findings (B §2, as of 2026-11-13):** Streamable HTTP is the one shared remote transport; a plain bearer header is mandatory (Copilot can't do OAuth servers); Copilot uses MCP tools only, not resources/prompts — so every capability must exist as a tool; Cursor routes MCP through its backend, so the server needs a public HTTPS address; legacy Codex can be configured GET-only, which blocks all pushes; Codex Cloud remote MCP support is unverified.

**Ingestion (B §3):** five paths — agent hooks (I1), MCP publish tools (I2), vendor pull APIs for Devin/Cursor (I3), in-sandbox sidecar reusing the adapters (I4), laptop daemon `peek push --watch` (I5). Chosen order: I2 + I5 first (small, vendor-independent), the Claude hook recipe (I1) next, vendor connectors (I3) later. Wire format is the existing derived `structured`/`brief` projection; raw transcript text needs a separate `sessions:raw` scope.

**Reversal triggers:** managed SaaS for many teams → C; pilot shows agents don't call the tools unprompted → invest in instructions/hooks, pause server work; one human across laptops with no cloud agents → B; customer egress blocks a third-party host → vendor pull.

### 6.2 Knowledge-graph store (C §3)

| Store | Verdict | Why |
|---|---|---|
| **SQLite typed node/edge tables (`node:sqlite`, FTS5, recursive CTE)** | **Chosen for local + self-host** | Already the repo's store engine; no new dependency or native addon; probe on Node 24.22.3 confirmed FTS5, recursive CTEs, JSON functions, extension loading |
| **Postgres edges + pgvector** | **Chosen for hosted multi-tenant, when built** | Commodity, permissive licence, pgvector everywhere; Neon free / ~$15 typical, Supabase $25 |
| Neo4j | Deferred (read-model if needed) | AuraDB Professional ≈ $66/mo min; Community GPLv3, no clustering; Docker on every laptop |
| Memgraph | Rejected for now | BSL; in-memory, RAM-priced |
| FalkorDB | Rejected | SSPLv1 obliges opening a hosting service's source |
| Postgres + Apache AGE | Rejected for now | Managed availability spotty; no vector built in |
| libSQL/Turso | Rejected | Turso recommends its Rust rewrite for new projects; libSQL has no concurrent writes |
| Kùzu → LadybugDB | Rejected | Kùzu archived 10 Oct 2025; fork young, single-writer, native addon install risk |
| SurrealDB | Watch | Best embedded↔cloud parity on paper; BSL; nobody uses SurrealQL here |
| Graphiti/Zep, Cognee, Mem0 | Rejected as stores; borrow ideas | Zep $125+/mo and ships transcripts to a third party; Mem0 removed graph memory from OSS in v3. Graphiti's bi-temporal edge model is adopted |

**Schema (C §2):** `node(id, kind, project_id, label, props, first_seen, last_seen)` and `edge(id, kind, src, dst, project_id, origin, confidence, observed_at, valid_from, valid_to, invalidated_by, src_session, src_msg_from, src_msg_to, props)` with `edge_out`, `edge_in`, `edge_proj` indexes and an FTS5 table over allow-listed text only. Deterministic ids (`s:<machine>:<adapter>:<native-id>`, `f:<project>:<repo-relative-path>`, `t:<session>:<msgIndex>:<callIndex>`, …) make re-ingest an idempotent upsert and local→hosted sync a copy, not a merge. Turns are not nodes; edges point at `(session, msgIndex)`, so the graph never holds message text. Edge origins: `parsed`, `heuristic`, `authored`, `derived`, `inferred` (inferred carries confidence + model id).

**Graph complements the feed, it doesn't replace it.** The feed stays the push channel and `scorePost` stays the single ranker; the graph becomes a pull channel and candidate generator, and adds a graph-proximity term to `relevance()`.

---

## 7. Recommended phasing (merged from B §6 and C §7)

| Phase | Scope | Shared by |
|---|---|---|
| **P0 — Retention ADR (no code)** | ADR 0002: graph stores structure, pointers, whitelisted args, authored/derived posts; transcript text local-only and opt-in; hosted transcript text needs per-project consent | Graph, server |
| **P1 — Portability & core overhaul (local behaviour unchanged)** | Machine-namespaced session ids; repo-relative, per-project claims in SQLite; server-assigned `seq` feed cursors (legacy cursors still decode); explicit `project` param alongside `dir`; principal-vs-label author split; content-hash drift; extract an application-service layer from the CLI; versioned feed schema + missing indexes; read paths stop rewriting the registry; shared JSONL reader; Codex `call_id`; unified cursor semantics; claims test coverage | Everything |
| **P2 — Local deterministic graph** | `graph.db` with §6.2 schema, filled by an extended usage scan sharing its watermarks plus feed/claims read-through; typed, named `peek graph` CLI + MCP tools (no free-form query); query-shape logging | Graph |
| **P3 — `peek serve`** | Streamable HTTP MCP sharing tool definitions with stdio; REST ingest; hashed project-scoped bearer tokens; Dockerfile; remote tool set excludes raw transcript modes; every capability exposed as a tool | Server |
| **P4 — Clients & ingestion** | CLI remote mode with outbox; `peek push --watch`; `publish_status` tool; Claude hook recipe; per-vendor setup docs; graph rows pushed as idempotent upserts | Server, graph |
| **P5 — Later, on evidence** | Inferred layer (extraction at handoff via host-harness pattern; embeddings); OAuth 2.1; Devin/Cursor pull connectors; hosted multi-tenant on Postgres; reassess graph store from query log | — |

Effort estimates from the researchers (judgment, not measured): 5–8 engineer-weeks to a usable self-host (P1, P3, P4), a further 4–6 for OAuth + hosted multi-tenancy.

---

## 8. Risks

- **Agents may not use it unprompted** — then transport isn't the bottleneck; instructions, skills and hooks are. Pilot before P5.
- **Network attack surface and auth** become agent-peek's responsibility; opt-in users lose the same-machine promise.
- **Cross-agent prompt injection:** a shared feed lets one agent place instructions in another's context (B §5.6). Posts must be rendered as data, with provenance.
- **Transcript secrets/PII:** `peek_session mode=raw` already returns transcript text locally; remote must exclude it by default.
- **Codex Cloud** remote MCP and **Claude cloud** `CLAUDE_SESSION_ID` are unverified; their integration may slip.
- **Public API breakage:** storage classes and path helpers are exported; moving storage is semver-visible. 0.x, but the project has behaved additively.
- **Heuristic `WROTE` edges** inherit Bash-parsing precision that hasn't been measured.
- **Subagent gap:** ~32% of transcripts (218 of 674 on the build machine) are hidden from usage until subagent attribution lands; graph completeness depends on it.
- **Free-form graph query tool** would bypass the retention boundary — keep queries named and typed.
- **`node:sqlite` is still experimental** in Node (bin shims suppress the warning).

---

## 9. Open decisions for the owner (feed the spec)

1. **Scope of this build.** All phases P0–P4 in one release, or P0–P2 (local overhaul + graph) first and the server second? Recommendation: one release branch covering P0–P4, with P5 out of scope.
2. **Hosting target.** Self-hostable `peek serve` (recommended) vs a managed service you run for others (→ Cloudflare or hosted Postgres).
3. **Retention.** May the hosted graph hold derived facts from private repos? May it ever hold transcript text? Recommendation: derived facts yes per project; transcript text never by default.
4. **Extraction payer** (P5): host agent at handoff (free) vs a background runner (token cost).
5. **Remote-less repos:** stay machine-local, or add a user-assigned project key? Recommendation: optional user-assigned key.
6. **Breaking changes:** acceptable to bump to 0.7/1.0 with documented breaks in exported storage classes, or must the library surface stay additive?

---

## 10. Unverified / evidence gaps

Codex Cloud remote MCP and hooks; `CLAUDE_SESSION_ID` and transcript layout in Claude cloud VMs; Copilot/Devin transcript or log APIs; MCP SDK `^1.30` support for the newest spec's stateless mode; Turso, D1, FalkorDB Cloud and Memgraph Cloud pricing; LLM extraction cost (transcript token volume not measured); Goose/Copilot watermark collisions, cross-session cursor replay and N+1 feed derivation are inferred from code, not reproduced.
