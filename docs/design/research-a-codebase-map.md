# Research A — agent-peek codebase map & localhost coupling

Read-only audit of `akhileshrangani4/agent-peek` at `main@b6197fe` (package version 0.6.0), done 2026-11-13. Every `file:line` reference below was read during this audit. Statements marked *Inference* are conclusions drawn from reading code, not behaviour observed at runtime.

## Summary

agent-peek only pulls data, and only on one machine. It learns about every session by walking a directory under the current user's `$HOME` or by running a local binary (`tmux`, `screen`, `sqlite3`, `git`). It keeps all of its own state in `~/.agent-peek` on that same disk: the session registry, file claims, the feed, the usage index, user agents and the skills archive. No module in `src/` opens a socket. The MCP server runs over stdio only, and `peek ui` is an Ink terminal app that refuses to start without a TTY. So getting off localhost is more than swapping the transport. The data flow has to reverse, so that agents push session events into a store instead of peek pulling files they wrote.

The codebase is healthy enough to start that work. Under Node 24, typecheck and lint are clean, all 573 tests pass, and line coverage is 90.56%. Four identity problems have to be fixed before any data crosses a machine boundary. Sessions are keyed by local transcript paths. Claims use absolute paths. Authors fall back to `user@hostname`. Feed cursors depend on the writer's wall clock.

**Load-bearing assumption:** the overhaul assumes cloud agents (Claude Code on the web, Codex cloud, Cursor background agents, Copilot coding agent) can be made to send their session data to an agent-peek store. Today this code can't reach any of them, because every adapter reads files written on the local machine. If a harness offers no hooks, no MCP client that can call a remote server and no transcript export, refactoring this codebase won't make that harness visible. Research B ([research-b-cloud-architecture.md](research-b-cloud-architecture.md)) compares the channels each harness offers. Confirm the channel for each target harness before committing to a push design. The brief also skips one alternative: much of the cross-agent value (claims, feed posts, coordination status) may come from sharing the small structured stores, without moving conversations at all.

## 1. What agent-peek is, in its own vocabulary

`package.json:4` describes the package as "Context feed and read-only visibility for local AI coding agents." `CONTEXT.md` sets the vocabulary. An **Agent** is a product installed on this machine (`claude-code`, `codex`, `cursor`, …). An **Adapter** is a parser for one transcript format, and adapters are independent of agents: `tmux` and `screen` belong to no agent, and `cursor` has no adapter (`CONTEXT.md:11-21`). **Observable** and **Manageable** are derived on the fly and never stored (`CONTEXT.md:50-59`). The durability section explains why the usage index is the one store that must outlive its sources: "transcripts are deleted at 30 days, so once a session's invocations are recorded, the index is the only remaining evidence the session happened" (`CONTEXT.md:114-119`). The README and the security page both state the trust boundary plainly: "`agent-peek` is same-user, same-machine only. No remote transport is exposed by the package" (`README.md:711-713`, `website/docs/security.mdx:6-10`).

The product has six capability families. Session observation covers `list`, `at` and `ui`. Coordination covers `coord`, `check`, `claim` and `release`. The context feed covers `post`, `feed` and `expand`. Handoff is `at --mode handoff`. Usage analytics is `usage`, and skills/agents inventory covers `skills` and `agents`. These surface as 22 CLI commands (`src/cli/index.ts`) and an MCP server with 12 tools, 3 prompts, 2 resources and 3 resource templates (`src/mcp/index.ts:25-255, 309-365`).

## 2. Module map

| Module | Size | Owns | Imports from |
|---|---|---|---|
| `src/core` | 2,881 lines, 10 files | `Engine` (list, peek, coordinate, register, tag), `Registry` (`registry.json`), `ClaimsStore` (`claims.json`), cursor codec, snapshot modes (raw, structured, brief, summary) with an in-memory summary cache and optional Anthropic summariser, coordination digest and overlap hints, handoff document and runner spawning, display names, typed errors, shared types | `adapters` (types only, `engine.ts:3-4`) |
| `src/adapters` | 1,833 lines, 15 files | `Adapter` contract, 8 built-in adapters, shared helpers (`readFileWindow`, `statusFromMtime`, terminal delta), `AdapterLoader` and external discovery through `AGENT_PEEK_ADAPTER_PATH` (`loader.ts:36-46`), `sqlite3` CLI wrapper | `core` (29 imports, including `core/snapshot` at `claude-code/index.ts:12`), `agents` (1) |
| `src/feed` | 867 lines, 6 files | Typed posts (`schema.ts`), per-project SQLite store, project and author identity, derived status posts, rank-and-pack to a token budget, post/read/expand orchestration, feed cursor | `core` (8) |
| `src/usage` | 1,407 lines, 8 files | Durable invocation index: schema, store, watermark scan, per-adapter extractors, typed query, coverage, report | `core` (4), `agents` (3), `adapters` (1) |
| `src/skills` | 1,613 lines, 11 files | Skill inventory across agents' roots, frontmatter parsing, name resolution, project discovery, archive and restore, reports | `usage` (8), `agents` (5), `feed` (1: `estimateTokens`, `skills/parse.ts:2`) |
| `src/agents` | 1,197 lines, 5 files | Agent catalog: builtin overlays, a generated third-party table (`generated-agents.ts`, 674 lines), user `agents.json` registry | nothing (leaf) |
| `src/cli` | 4,388 lines, 11 files | `cac` command tree (`index.ts`, 2,455 lines, 68 top-level functions), Ink TUIs (`ui.ts`, `skills-ui.ts`), static reports, renderer, path helpers | `skills` (10), `core` (9), `usage` (6), `agents` (5), `feed` (2), root `index` (2) |
| `src/mcp` | 1,019 lines, 2 files | stdio MCP server: tools, prompts, resources (`index.ts`); skills and usage tool bodies (`skills.ts`) | `skills` (8), `core` (4), `usage` (4), `feed` (2), `agents` (1), root `index` (1) |

The dependency graph is mostly layered, with three leaks. `agents` is the leaf. `core` and `adapters` form a type-level cycle: `core/engine.ts:3-4` imports the loader and adapter types, and adapters import core types and, in Claude Code's case, core snapshot logic (`claude-code/index.ts:12`). `skills` reaches into `feed/schema` for a token estimator (`skills/parse.ts:2`). Both front-ends build their own wiring from the root `createEngine` (`src/index.ts:112-128`; `mcp/index.ts:258`; `cli/ui.ts:32`) and call stores directly, with no application-service layer between them. *Inference:* business rules therefore live in CLI handlers. Self-identity resolution is one example (`cli/index.ts:1629-1640`), and so is claim-path normalisation (`cli/index.ts:1269-1283`). An HTTP server would have to duplicate or extract both.

### Public surface and entry points

`package.json:8-21` exports three subpaths. `.` maps to `dist/index.js`, `./adapter` maps to `dist/adapters/types.js` (the plugin contract) and `./mcp` maps to `dist/mcp/index.js`. Three binaries are declared (`package.json:22-26`): `peek` and `apeek` both point at `bin/peek.js`, and `agent-peek-mcp` points at `bin/agent-peek-mcp.js`. The published files are `dist`, `bin`, `skills`, `README.md` and `LICENSE` (`package.json:27-33`). Each bin shim exits with code 5 below Node 24, filters the `node:sqlite` ExperimentalWarning and then dynamically imports the built entry (`bin/peek.js:2-19`).

`src/index.ts` exports the following, all of which an overhaul has to treat as public API:

- `VERSION` and the session, message, cursor, snapshot and coordination types (lines 4-14)
- 13 error classes (16-21)
- the agents API (23-31) and the skills inventory, archive and report API (33-50, 66-67)
- the storage classes `Registry`, `ClaimsStore` and `Engine`, plus the cursor codec (52-55)
- the usage API, including `UsageStore` and `usageDbPath` (60-72)
- snapshot transforms and handoff builders (73-74) and the coordination codec (75-78)
- the feed API, including `FeedStore`, `feedDbPath`, `projectIdentity` and `resolveAuthor` (80-88)
- `AdapterLoader`, `discoverExternal` and the adapter types (90-91)
- `createEngine` (106-128)
- the CLI renderer helpers `Row`, `Rows`, `sparkline` and others (129-130)

Because storage classes and on-disk path helpers are exported, moving storage counts as a semver-visible change, not just an internal refactor.

## 3. Data model and storage

### Normalised shape

Every adapter produces the same two shapes. `SessionEntry` (`core/types.ts:7-30`) has these fields:

- an adapter-prefixed `id`, plus `adapter`
- `transcriptPath`, documented as "absolute path, DB path, or local terminal URI"
- optional `name`, `cwd`, `tag` and `pid`
- `sourceType` (`file | directory | database | terminal | manual`)
- `lastSeen`, `status` (`active | idle | ended`) and `parentSessionId` for subagents

`RawMessage` (`core/types.ts:54-60`) carries a `role` (`user | assistant | system | tool`), optional `text`, `toolCalls`, a `timestamp` and `raw: unknown`, which holds the adapter's whole original record. `ToolCall` (`45-52`) has `name`, `input`, `output`, `status` and an optional `id`. A cursor is `CursorData { adapter, byteOffset, msgIndex, tail? }`, serialised as base64url JSON (`types.ts:62-70`, `cursor.ts:4-7`). The contract has only two required methods, `scan()` and `read(entry, cursor?)`. A `watch?` method is declared but "Reserved for v2; not used in v1" (`adapters/types.ts:11-36`).

A knowledge graph needs stable node identities, and this shape doesn't provide them. A message's only identity is its position (`sessionId`, `msgIndex`). There's no message id, no parent-message link and no content hash, and a tool call's `id` is optional and missing for Codex (see §6). The raw payload travels with every message regardless.

### Persisted stores

| Store | Engine | Location | Schema and indexes | Concurrency | Holds |
|---|---|---|---|---|---|
| Session registry | JSON `{version: 1, sessions}` | `~/.agent-peek/registry.json` (`core/registry.ts:39-41`) | Map keyed by session id. A corrupt file is renamed to a backup and reset (`102-116`) | `proper-lockfile`, 5 retries at 50–500 ms, 10 s stale (`43-48`, `130-132`); temp file then rename (`144-147`) | Every discovered `SessionEntry`; pruned after 24 h by default (`42`, `78`) |
| File claims | JSON `{version: 1, claims}` | `~/.agent-peek/claims.json` (`core/claims.ts:22-26`) | Map keyed by UUID; expired claims pruned on each write (`49`, `68`) | Same lock and rename pattern (`122-124`, `133-136`) | `FileClaim`: absolute `files` (`cli/index.ts:1282`), `owner`, `creator`, `cwd`, `createdAt`, `expiresAt` (`types.ts:32-43`) |
| Feed | `node:sqlite` `DatabaseSync` (`feed/store.ts:6`, `19-21`) | `~/.agent-peek/feed/<projectId>.db` (`store.ts:25-27`) | `posts` (id PK, type, origin, author_session, created_at, expires_at, superseded_by, reply_to, validity, `doc` JSON) with index `posts_created`; `post_paths(post_id, path)` with an index on path; `ingestions` telemetry (`29-54`). No schema version and no migrations | WAL, `busy_timeout = 5000` (`90-91`) | Posts (the full `FeedPost` lives in `doc`), path index, read telemetry |
| Usage index | `node:sqlite` | `~/.agent-peek/usage.db`, one per machine (`usage/store.ts:30`) | `meta`; `invocations` PK `(source_path, msg_index, call_index, source_kind)` with indexes on tool, skill, timestamp; `watermarks` keyed by `source_path` (`usage/schema.ts:106-140`). `SCHEMA_VERSION = 1`, `MIGRATIONS = []`, policy "additive only … never a drop" (`104`, `142-147`); a newer schema is left untouched (`store.ts:127`) | WAL, busy timeout (`115`, `118`); one `BEGIN IMMEDIATE` per source (`150`) | Whitelisted invocation attributes only, per ADR 0001 (`docs/adr/0001-…md:1`, `33`) |
| User agents | JSON | `~/.agent-peek/agents.json` (`agents/registry.ts:21-25`) | none | Temp file then rename, no lock (`48`) | User-defined agents |
| Skills archive | Directories plus a JSON log | `~/.agent-peek/archive/<id>/`, `archive/log.json` (`skills/archive.ts:80-84`, `205`) | none | Temp file then rename, no lock (`291`, `333`) | Archived skill directories and the archive log |
| Peek cursor | Client-held base64url string | none | `{adapter, byteOffset, msgIndex, tail?}` | n/a | Read position |
| Coordination cursor | Client-held string, optionally written to `--cursor-file` (`cli/index.ts:1765-1768`) | Caller's choice | Per-session cursor plus compacted session state | n/a | Incremental coordination state |
| Handoffs | Not persisted; built on demand. `--out` writes a file the user chooses (CHANGELOG 0.6.0) | n/a | n/a | n/a | n/a |
| Summary cache | In-process `Map` with TTL (`core/snapshot.ts:286-295`) | Memory | Keyed `session::cursor` | n/a | LLM summaries |

The security page is out of date. It says "the feed database is the only place `peek` writes data of its own" (`website/docs/security.mdx:17-18`), but the table above lists five more stores that peek writes: the registry, claims, the usage index, agents and the archive.

### How each adapter reads transcripts

| Adapter | Discovery root | Source format | Read strategy | Cursor meaning |
|---|---|---|---|---|
| claude-code | `~/.claude/projects/<proj>/*.jsonl`, plus subagents at `<session>/subagents/agent-*.jsonl` (`claude-code/index.ts:22`, `77-96`) | JSONL | `readFileWindow` from the byte offset; `parseJsonlSlice` stops at the last newline; `settleToolStatuses` pairs tool results with their calls (`46-66`; `parse.ts:98-127`) | Real byte offset; incremental |
| codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` via four nested `readdir` calls (`codex/index.ts:23`, `89-101`); scan reads only the header line (`127-128`) | JSONL | Same window-and-slice approach as Claude Code (`58-77`; `parse.ts:123-153`), but no status settling and `call_id` is dropped (§6) | Byte offset |
| gemini | `~/.gemini/tmp/<project>/chats/session-*.json` (`gemini/index.ts:21-22`, `92-96`); project root from `projects.json` / `.project_root` (`105`, `117`) | One JSON document per session | Whole file read and `JSON.parse`d on scan and on every read, then sliced (`32`, `53-75`) | `msgIndex` only; full re-parse each time |
| opencode | `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode` (`opencode/index.ts:105-107`) | One JSON file per message and per part | Every message and part file is walked and read on each read, then sorted by time (`52-78`) | `msgIndex`; `byteOffset` holds a message count (`47`) |
| goose | `~/.local/share/goose/sessions/sessions.db`, plus legacy `*.jsonl` (`goose/index.ts:151`, `158`) | Goose's own SQLite database | Runs `sqlite3 -json -readonly` (`adapters/sqlite.ts:12-16`); session id escaped and interpolated into the SQL (`goose/index.ts:76-77`) | `msgIndex` slice of the full result (`144`) |
| copilot-cli | `~/.copilot/session-state/<id>/` (`copilot-cli/index.ts:139`) | Directory of event files | Session directory re-read on each read (`44-49`, `60-106`); `transcriptPath` is the directory (`33`) | `msgIndex` slice |
| tmux | Local `tmux` server through `execFile` (`tmux/index.ts:69`) | Terminal scrollback | `capture-pane -p -S -` captures everything on each read (`42`); delta by line count plus tail (`common.ts:26-55`) | Line index plus tail |
| screen | `screen -ls`, then `screen -X hardcopy -h` into a `mkdtemp` file (`screen/index.ts:25`, `86-89`) | Scrollback hardcopy | Same approach as tmux | Line index plus tail |

Terminal adapters are hidden from `list` and `peek` unless asked for (`engine.ts:87`, `99`, `342-346`). Two inconsistencies matter for portability. First, the adapters ignore `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (`claude-code/index.ts:22`, `codex/index.ts:23`), while skill-root resolution respects both (`agents/builtin.ts:140-141`). Second, home-directory lookup differs by module. The stores call `homedir()` directly (`registry.ts:39`, `claims.ts:23`, `feed/store.ts:26`, `usage/store.ts:30`). The adapters and most other code use `process.env.HOME ?? homedir()`.

## 4. Localhost coupling audit

A search of `src/` for `node:http`, `node:net`, `node:https`, `createServer`, unix sockets, `/proc`, `lsof` and `ps` found nothing. agent-peek inspects no processes, opens no ports and listens on no sockets. Its process id appears only in temporary file names (`registry.ts:144`, `claims.ts:133`, `agents/registry.ts:48`, `skills/archive.ts:291`). Every coupling is to the filesystem, local binaries or local identity.

| # | Assumption | Where | What breaks for a cloud or remote agent |
|---|---|---|---|
| 1 | Transcripts are found by walking the current user's home directory | `claude-code/index.ts:22`, `codex/index.ts:23`, `gemini/index.ts:22`, `opencode/index.ts:105-107`, `goose/index.ts:151`, `158`, `copilot-cli/index.ts:139` | A cloud agent's transcript sits in its own VM or container, so peek on a laptop sees nothing. Peek run inside the cloud sandbox sees only that sandbox. |
| 2 | Adapters ignore config-dir env overrides | `claude-code/index.ts:22`, `codex/index.ts:23` vs `agents/builtin.ts:140-141` | A harness that moves its config directory is invisible even on the local machine. *Inference:* relocated config dirs are likely in containerised agents. |
| 3 | External binaries are on `PATH` | `tmux/index.ts:69`, `screen/index.ts:97`, `adapters/sqlite.ts:12`, `feed/identity.ts:19` (`git`), `core/handoff.ts:540` (agent CLIs) | Minimal images lack `tmux`, `screen` and `sqlite3`, and terminal adapters have no meaning remotely. Harness handoff spawns whichever CLI is installed on the machine running peek. |
| 4 | All state lives in `~/.agent-peek` on local disk | `registry.ts:39-41`, `claims.ts:22-26`, `feed/store.ts:25-27`, `usage/store.ts:30`, `agents/registry.ts:21`, `skills/archive.ts:80` | A laptop and a cloud sandbox each keep a private registry, claims file and feed database, and an ephemeral sandbox loses its copies at teardown. |
| 5 | Cross-process safety relies on file locks, atomic rename and SQLite WAL | `registry.ts:130-132`, `claims.ts:122-124`, `feed/store.ts:90`, `usage/store.ts:115` | These only coordinate writers that share one local filesystem; writers on different hosts are not coordinated. (SQLite's WAL is documented as unsuitable for network filesystems. That comes from training data and was not checked this session.) |
| 6 | Session identity is adapter plus native id, and `transcriptPath` is a local path or a `tmux://` / `screen://` URI | `core/types.ts:8-10`, `tmux/index.ts:92` | Identity has no host or tenant dimension, and `transcriptPath` means nothing off the machine. *Inference:* registry keys could collide once sessions from several hosts merge. |
| 7 | Self-identity comes from `CLAUDE_SESSION_ID`, else a cwd match against locally discovered sessions, else `user@hostname` | `feed/identity.ts:54-77`, `cli/index.ts:1629-1640` | A cloud agent has no local session to match, so it falls through to the `user@hostname` of a throwaway container and becomes an anonymous, unstable author. Only Claude Code has an env-var path. |
| 8 | Project identity is the normalised git remote, else the realpath of the git common dir or directory | `feed/identity.ts:37-52` | Remote-based ids already work across machines. A checkout without `origin` falls back to a hash of a local path, which splits the feed per machine. |
| 9 | Claims store absolute paths resolved on the claimer's disk | `cli/index.ts:1282`, `core/claims.ts:58-66` | `/home/a/repo/src/x.ts` and `/workspace/repo/src/x.ts` never match, so cross-machine conflicts go undetected. Feed posts use repo-relative paths instead (`mcp/index.ts:105`, `cli/index.ts:707`), giving the codebase two path conventions. |
| 10 | Coordination infers written files from tool calls and drops paths that don't exist on the reader's disk | `core/coordination.ts:365`, `393`, `714-726` | Files a remote agent writes at its own absolute paths fail `existsSync` locally and vanish from the digest. |
| 11 | Feed drift compares local file mtime with the post's `createdAt` | `feed/index.ts:167-179` | A remote reader's checkout has unrelated mtimes, and files it lacks mark posts as drifted. Writer and reader clocks get mixed. |
| 12 | The incremental feed cursor watermarks on the writer's `createdAt` | `feed/index.ts:63-77` | *Inference:* clock skew between machines can hide posts or show them twice. |
| 13 | Liveness comes from transcript mtime | `adapters/common.ts:6` (`statusFromMtime`) | Synced or copied transcripts get fresh mtimes, so a remote session's liveness can't be read from mtime. |
| 14 | A peek cursor records its adapter but not its session or host | `core/cursor.ts:9-29`, `core/engine.ts:109-115` | *Inference:* a cursor from one session decodes cleanly against another session of the same adapter. A networked API would need cursors bound to session and tenant. No test I read covers this case. |
| 15 | The MCP transport is stdio only, and feed and resource defaults use the server's `process.cwd()` | `mcp/index.ts:548-549`; `376`, `450`, `473`, `490` | A cloud agent can't attach to a process on a laptop. A remote server has no meaningful cwd to stand in for "this project". |
| 16 | `peek ui` and the skills UI require a TTY | `cli/ui.ts:19-30`, `cli/skills-ui.ts:32` | There's no server to expose. A web UI would be new work. |
| 17 | Security relies on OS file permissions | `README.md:711-713`, `website/docs/security.mdx:6-10` | Off-box use needs authentication, tenancy and a transcript exposure policy. `peek_session mode=raw` and the `tail` resource return transcript text (`mcp/index.ts:27-40`, `362-366`). |
| 18 | The handoff harness spawns a local CLI with `process.env` | `core/handoff.ts:476-511` | Generating handoffs server-side would run an agent CLI under the server's credentials. The MCP path already returns `material` without spawning anything (CHANGELOG 0.6.0). |

Some pieces already work across machines: the git-remote project id, the repo-relative path convention and typed links on feed posts, the MCP handoff `material` mode, and the usage index's refusal to store raw input.

## 5. Existing indexing, query patterns and re-parse costs

The most expensive pattern is in session listing. `Engine.list()` scans every adapter and upserts the results into the registry, so each read takes a file lock and rewrites `registry.json` (`engine.ts:83-101`). `peek()` calls `list()` before resolving its selector (`106`), and `resolve()` sorts the full registry (`279`). A comment in the usage scanner records that the registry is "heavily stale (1131 of 1749 entries pointed at deleted files when this was written)" (`usage/scan.ts:32-34`).

Coordination reads each session twice. If a session has a prior cursor and the delta read is non-empty, it reads the whole transcript again from byte 0 and recomputes `toStructured` over every message (`engine.ts:177-190`). `readFileWindow` allocates the rest of the file as one `Buffer` (`adapters/common.ts:57-77`), and the Codex scanner notes that "Rollouts can be tens of MB" (`codex/index.ts:127`). *Inference:* each coordination poll costs time proportional to the total transcript bytes of every changed session. Gemini, OpenCode, Goose and Copilot CLI re-read and re-parse whole sessions on every read; their cursors only slice the result.

The feed has the same full-scan habit at a smaller scale. `candidates()` selects every live post ordered by `created_at` and filters on `validity`, `expires_at` and `type`, none of which has an index (`feed/store.ts:127-139`); the only indexes are `posts_created` and `post_paths_path` (`42`, `47`). Each read also runs an `UPDATE` to expire posts lazily (`139`, `155`). `checkDrift` stats every path on every candidate on every read, including incremental reads (`feed/index.ts:67-69`, `167-179`). Derived status posts call `engine.list()` and then `engine.peek(structured)` for each live session in the directory (`feed/derive.ts:32-38`). *Inference:* because each `peek` re-runs `list()`, one feed read triggers N+1 full adapter scans.

The usage index is the one store already built for incremental indexing, so its patterns are the ones worth keeping. It skips unchanged sources by size and mtime (`usage/scan.ts:105-110`), rescans from zero on shrink, uses a deterministic primary key so rewrites are idempotent, and commits rows and watermark in a single transaction (`139-158`). It has gaps. Indexes exist on `tool`, `skill` and `timestamp` but not on `adapter`, `session_id`, `cwd` or `agent` (`usage/schema.ts:129-131`). `allInvocations()` selects the whole table (`usage/store.ts:238-241`).

Watermarks are keyed by `transcriptPath`, and that key is wrong for two adapters. All Goose database sessions share `transcriptPath = sessions.db` (`goose/index.ts:24`, `35`). *Inference:* once the first Goose session is recorded, later Goose sessions with the same file size and mtime are skipped (`scan.ts:108`), and the `(source_path, msg_index, …)` primary key can collide across sessions. Copilot CLI's `transcriptPath` is a directory (`copilot-cli/index.ts:33`), and *inference:* a directory's mtime doesn't change when a file inside it is appended to. Both adapters declare `observes: []` (`goose/index.ts:20`, `copilot-cli/index.ts:16`), which limits the impact on today's skills coverage. A conversation index must not inherit this keying.

### Entities and relations that already exist

The codebase already holds an implicit graph, spread across stores that use inconsistent ids.

- **FeedPost** (`feed/schema.ts:27-43`) links an author session (`author.session`) to a project, worktree, branch, paths and topics (`scope`). It links to other posts through `links.replyTo`, `supersedes` and `mentions`. It cites `evidence` of kind `file | commit | session`, with path, line, ref and cursor (`10-16`). The `reply_to` and `superseded_by` columns and the `post_paths` table are queryable. `topics`, `mentions`, `worktree` and `branch` exist only inside the `doc` JSON. `mentions` affects ranking (`feed/rank.ts:47`).
- **FileClaim** links an owner or creator session to absolute file paths, with a TTL.
- **SessionEntry.parentSessionId** is a subagent-to-parent edge (`core/types.ts:18-29`).
- **Usage invocation** links a session to a tool, a skill, an agent and a cwd, and keeps `native_call_id` and `attribution_agent` (`usage/schema.ts:111-128`).
- **Coordination overlap hints** compute session × session × file overlap with a severity on the fly; nothing is stored.
- **Project identity** connects sessions (through cwd), feed databases and skills projects. Skills project discovery resolves worktrees to their main checkout (`skills/projects.ts:16-41`).

Put together, these imply edges such as Session —spawned→ Session, Session —wrote→ File, Session —authored→ Post —replies-to/supersedes→ Post —cites→ File/Commit/Session, Session —claimed→ File, Session —invoked→ Skill/Tool, and Session —in→ Project. None of them is stored as an edge in one place, and their keys disagree: absolute vs repo-relative paths, and `adapter:id` vs `user@host`.

## 6. Overhaul candidates

The candidates below are ordered by how much they block the three goals (overhaul, off-localhost, graph indexing). "Read" means the defect is visible directly in the cited code. "Inference" means it follows from the code but was not reproduced.

| # | Candidate | Evidence | Why it matters | Basis |
|---|---|---|---|---|
| 1 | Reads write state: every `list()` takes a lock and rewrites the registry | `core/engine.ts:83-101`, `core/registry.ts:20-23` | Concurrent server reads would serialise on one JSON file; the rewrite cost grows with the registry | Read |
| 2 | Coordination reads changed sessions twice | `core/engine.ts:177-182` | Polling cost grows with transcript size, not delta size | Read |
| 3 | Session identity is tied to `transcriptPath` | `core/types.ts:10`, `usage/scan.ts:99-110`, `goose/index.ts:35` | Blocks multi-host merging; already wrong for Goose and Copilot CLI watermarks | Read (collision effect: Inference) |
| 4 | Codex drops `call_id` and skips status settling | `codex/parse.ts:52-68` (the record type has `call_id` at `32`); `settleToolStatuses` is used only by Claude Code (`claude-code/index.ts:12`, `62`) | Codex tool calls can't be joined to their results, and that join is a core graph edge | Read |
| 5 | JSONL slicing is duplicated byte for byte | `claude-code/parse.ts:103-127` vs `codex/parse.ts:129-153` | One fix has to land in two places; one helper would serve every JSONL format | Read |
| 6 | Cursor fields mean different things in each adapter | `opencode/index.ts:47` (`byteOffset` = message count); Gemini, Goose and Copilot slice by `msgIndex` | A store that persists cursors needs one meaning | Read |
| 7 | Two ways into SQLite | `node:sqlite` in the stores vs the `sqlite3` CLI with escaped, string-built SQL (`adapters/sqlite.ts:12-16`, `goose/index.ts:76-77`) | Adds a runtime binary dependency; injection is guarded only by escaping | Read |
| 8 | Leaky layers | core↔adapters type cycle (`engine.ts:3-4`); adapter imports core snapshot (`claude-code/index.ts:12`); skills imports feed schema (`skills/parse.ts:2`); CLI renderer exported as library API (`index.ts:129-130`); `UsageStore.handle()` returns the raw database and is commented "Not exported from the package", yet `UsageStore` is exported (`usage/store.ts:232-235`, `index.ts:61`) | Blurs the seams an overhaul would cut along. `handle()` undercuts the claim that `queryUsage` is "the only public way to read" the index (`index.ts:57-59`) | Read |
| 9 | Oversized CLI with logic inside | `cli/index.ts`: 2,455 lines, 68 functions, including identity and path rules (`1269-1283`, `1629-1640`); excluded from coverage (`vitest.config.ts`) | A second front end (HTTP) can't reuse logic that lives in CLI handlers | Read |
| 10 | Feed database has no schema version | `feed/store.ts:29-54`, unlike usage's `meta` table | No anchor for any future migration, including adding graph columns | Read |
| 11 | Inconsistent home and env resolution | §3 last paragraph | Breaks containerised harnesses and makes tests depend on `HOME` | Read |
| 12 | Polling only; no event model | `watch?` reserved and unused (`adapters/types.ts:34-35`) | A push or ingest design has no existing seam to build on | Read |
| 13 | Docs drift on what peek writes | `website/docs/security.mdx:17-18` | The security promise has to be restated accurately before it changes | Read |
| 14 | Test gaps | See §7 coverage table | Claims, the stores that matter most for cross-agent coordination, have almost no direct coverage | Measured |

## 7. Typecheck, lint, test and coverage results

The sandbox's default Node was v20.20.2, below the `>=24` engine floor. I downloaded Node v24.22.3 from nodejs.org into `/tmp`, checked its SHA-256 against the published `SHASUMS256.txt`, and ran the existing lockfile-installed `node_modules` with it. No repository files changed: `git status` showed only the `bun.lock` that was already untracked before the audit.

- `npm run typecheck` (`tsc --noEmit`) exited 0 with no errors.
- `npm run lint` (`oxlint src test`) reported 0 warnings and 0 errors across 115 files with 96 rules.
- `npm test` (`pretest` builds, then `vitest run`) passed 573 tests in 43 files in 27.76 s.
- Coverage (`vitest run --coverage`, v8): statements 87.53%, branches 76.93%, functions 90.88%, lines 90.56%. All four clear the configured thresholds of 85 / 84 / 80 / 70 (`vitest.config.ts`).

The coverage number excludes `types.ts` files, `src/cli/index.ts`, `ui.ts`, `render.ts`, `*-report.ts`, `skills-ui.ts` and `src/mcp/index.ts` (`vitest.config.ts:1-31`). That leaves the 2,455-line CLI and the 665-line MCP server outside it. These files had the lowest coverage:

| File | Lines % | Branches % | Note |
|---|---|---|---|
| `src/core/claims.ts` | 4.41 | 4.76 | No test file imports `ClaimsStore`. Claims are exercised only through CLI integration tests such as "claim adds temporary file ownership that check and coord can see". *Inference:* those tests spawn the built binary, so v8 doesn't instrument them. |
| `src/skills/assemble.ts` | 57.14 | 42.55 | |
| `src/adapters/sqlite.ts` | 70.00 | 33.33 | |
| `src/adapters/gemini/index.ts` | 86.20 | 53.33 | |
| `src/adapters/tmux/index.ts` | 89.47 | 57.69 | |
| `src/adapters/copilot-cli/index.ts` | 87.32 | 63.15 | 2 tests |
| `src/adapters/goose/index.ts` | 94.28 | 64.40 | 2 tests; none covers multiple DB sessions |
| `src/adapters/opencode/index.ts` | 98.24 | 63.93 | 1 test |
| `src/core/registry.ts` | 86.88 | 76.47 | |

CI is `.github/workflows/ci.yml`. It runs on pushes to `main` and on pull requests, on Node 24 only, with the steps `npm ci` → `lint` → `typecheck` → `build` → `coverage`. The repository has no release or publish workflow, and `prepublishOnly` runs the build (`package.json` scripts). *Inference:* releases are published by hand.

## 8. Conventions and contracts an overhaul must not silently break

The runtime and toolchain are Node `>=24` (`package.json` engines, enforced by the bin shims with exit code 5), ESM (`"type": "module"`), tsup, TypeScript ~5.9.3, Vitest and oxlint. The stores rely on `node:sqlite`, which is still experimental, so the bin shims suppress its warning (`bin/peek.js:8-16`). The project is on 0.x, with prose CHANGELOG entries per release. It still behaves as if additive compatibility matters. When 0.6.0 rewrote handoff, `HandoffSnapshot` gained fields, and the changelog notes that "the regex fields stay."

These contracts are visible to users, agents or third-party code:

1. **CLI.** There are 22 commands under the `peek` and `apeek` aliases, with `--json` output and JSON error records under `--json` (CHANGELOG 0.6.0). The exit codes are relied on: 1 when `check` finds conflicts, 5 for invalid usage (`cli/index.ts:1274-1276`), an unsupported Node (`bin/peek.js:3-5`) or a missing TTY (`cli/ui.ts:19-29`), and 6 for environment errors such as a read-only home directory. Integration tests assert the 1 and 6 cases by name ("check exits 1 for active writing conflicts", "a read-only home is an environment error (exit 6)").
2. **MCP.** The `agent-peek-mcp` binary exposes these tools: `peek_session`, `list_sessions`, `coordination_digest`, `tag_session`, `post_to_feed`, `read_feed`, `expand_post`, `usage_report`, `skills_report`, `skill_detail`, `archive_plan`, `list_agents` (`mcp/index.ts:27-222`). The prompts are `coordinate-agents`, `session-handoff` and `avoid-overlap` (`237-249`). The resources are `agent-peek://sessions` and `agent-peek://feed`, plus templates `agent-peek://session/{selector}/brief|handoff|tail` (`315-362`). Clients hard-code these names and argument schemas.
3. **Library.** Everything exported from `src/index.ts` (§2) is public API, including the storage classes and path helpers. The `./adapter` subpath is a plugin ABI: external adapters load through `AGENT_PEEK_ADAPTER_PATH` (`adapters/loader.ts:36-46`), so changing `scan`/`read` or `SessionEntry` breaks third-party adapters.
4. **Cursor strings.** They are opaque but decodable, and clients persist them (for example with `--cursor-file`). An encoding change must fail cleanly; `InvalidCursorError` and `CursorMismatchError` already exist (`core/cursor.ts:9-29`).
5. **On-disk state.** The `~/.agent-peek` layout is part of the contract. `usage.db` may only change additively, because "transcripts that have expired cannot be re-derived" (`usage/schema.ts:142-147`).
6. **ADR 0001.** The usage index stores whitelisted arguments and never raw tool input, and the rule binds "any MCP surface built over usage data" (`docs/adr/0001-…md:1`, `33`, `43-44`). It doesn't cover `peek_session` transcript reads. A conversation graph that stores transcript text would be a new store with a new retention decision, and it should get its own ADR.
7. **Bundled agent skill.** `skills/agent-peek/SKILL.md` ships in the npm package and teaches agents the CLI, with evals in `skills/agent-peek/evals/evals.json`. Renaming commands or flags breaks behaviour agents have already learned.
8. **The security promise.** "Same-user, same-machine only" (`README.md:711`). Any remote mode changes that promise, so it should be opt-in and documented as such.

## 9. Implications for the overhaul (inferences)

These are inferences from the current state. Research B owns the architecture choice, and the graph-DB researcher owns the store choice.

The cleanest seam for ingestion is the output of `Adapter.read()` plus `SessionEntry`. That pair is already the normalised boundary every adapter and the usage extractor share. A push ingest could accept the same shape, extended with host or tenant identity, a stable per-message id and tool call ids preserved. Adapters would then run wherever the transcript lives, including inside a cloud sandbox, and post upstream.

Identity has to be fixed before any data crosses machines, because each later layer joins on these keys:

- Sessions should be keyed by tenant/host + adapter + native id, never by `transcriptPath`.
- Claims, coordination and feed should share repo-relative paths scoped by project id.
- Authors should come from an explicit token or a per-harness environment variable rather than a cwd match.
- Feed cursors should use a server-assigned sequence instead of the writer's `createdAt`.

For indexing, the usage index is the template to copy: watermarks, an idempotent primary key, per-source transactions, additive migrations and an explicit whitelist. The feed already carries typed links worth promoting to edges. What's missing for a graph is node identity at the message and tool-call level, and one consistent path and session key across stores.

## Evidence gaps

These claims rest on code reading only and were not reproduced at runtime:

- the Goose watermark collision and the Copilot directory-mtime skip (§5)
- cross-session cursor replay (§4, row 14)
- the N+1 scans during feed derivation (§5)
- the reason `claims.ts` coverage is low (§7)

I didn't run peek against real Claude Code, Codex, Gemini, OpenCode, Goose or Copilot CLI transcripts; the adapter behaviour described here comes from code and the test fixtures. The SQLite-on-network-filesystem caveat in §4 is from training data.
