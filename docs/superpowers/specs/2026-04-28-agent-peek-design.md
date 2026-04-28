# agent-peek — Design Spec

**Date:** 2026-04-28
**Status:** Approved for implementation planning
**Author:** akhilesh@tambo.co (with Claude)

## Problem

When multiple AI coding agents run in parallel (sibling Claude Code sessions, an agent + a researcher, a fleet of task-runners), each agent works in isolation. There is no built-in way for one agent to ask "what is the other agent doing right now?" Agents end up duplicating work, missing context the sibling already discovered, or stepping on each other.

Inspirations:
- [anthropics/claude-code#30083](https://github.com/anthropics/claude-code/issues/30083)
- [anthropics/claude-code#29086](https://github.com/anthropics/claude-code/issues/29086)
- Gas City's pattern of peeking into other Claude sessions.

## Goal

Ship a generic, framework-agnostic npm package that lets any AI agent **read-only** peek into another agent's chat session — get a snapshot of what it is currently doing, what it has done, and (optionally) a token-cheap delta since the caller last looked.

## Non-Goals (v1)

- Cross-user / cross-machine peek
- Writing into other sessions (no inbox, no injection, no transcript edits)
- Live push streaming (caller polls between turns; no file watcher / async iterator)
- Web UI / dashboard
- Obsidian or other vault integration (kept in user's own workflow, not core)
- Long-term archival / indexed search
- Windows support

## Decisions Summary

| Area | Decision |
|------|----------|
| Target scope | Generic protocol with adapter layer |
| Peek output | Tiered: `raw` (default), `structured`, `summary` |
| Addressing | Registry tracks `id`, `cwd`, `tag`, `status`; selectors resolve any |
| Storage | Hybrid: filesystem registry default; adapter may use a daemon if needed |
| Surfaces | Library core + CLI wrapper + MCP server wrapper |
| Language | TypeScript, npm |
| Direction | Read-only |
| Modes | One-shot snapshot + cursor-based diff (`--since`); no live tail |
| Lifecycle | Both passive scan and explicit `register` |
| Security | Same-user only; trust = filesystem permissions |
| v1 adapters | `claude-code` + `codex` |
| Layout | Hybrid: single `agent-peek` package ships core/CLI/MCP/built-in adapters; ext adapters via `agent-peek-adapter-*` npm convention |
| npm name | `agent-peek` |
| CLI bin | `peek` (with `apeek` alias for PATH collisions) |
| MCP bin | `agent-peek-mcp` |

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                     agent-peek                         │
│                                                        │
│   ┌──────────┐   ┌──────────┐   ┌──────────────────┐   │
│   │   CLI    │   │   MCP    │   │  Library API     │   │
│   │  (peek)  │   │ (server) │   │  (peek/list/...) │   │
│   └─────┬────┘   └─────┬────┘   └────────┬─────────┘   │
│         └──────────────┴─────────────────┘             │
│                        │                               │
│              ┌─────────▼─────────┐                     │
│              │   Core engine     │                     │
│              │  - registry       │                     │
│              │  - peek/diff      │                     │
│              │  - snapshot tiers │                     │
│              └─────────┬─────────┘                     │
│                        │                               │
│              ┌─────────▼─────────┐                     │
│              │  Adapter loader   │                     │
│              │  (built-in + ext) │                     │
│              └─┬────────┬────────┘                     │
│                │        │                              │
│       ┌────────▼─┐   ┌──▼──────┐  …  ext adapters     │
│       │claude-cd │   │  codex  │     via npm convention│
│       └──────────┘   └─────────┘                       │
└────────────────────────────────────────────────────────┘
            │              │
            ▼              ▼
    ~/.claude/...     ~/.codex/...
```

Three surfaces (CLI, MCP, library) wrap one core. Core delegates session discovery and transcript reading to adapters. Built-in adapters: `claude-code`, `codex`. External adapters loaded by convention (`agent-peek-adapter-*` or `@scope/agent-peek-adapter-*` packages on `NODE_PATH` / `AGENT_PEEK_ADAPTER_PATH`).

## Components

### Core (`src/core/`)

#### Registry (`registry.ts`)

- File: `~/.agent-peek/registry.json` (atomic writes via tmp+rename, lockfile-guarded).
- Entry shape:
  ```ts
  type SessionEntry = {
    id: string;             // adapter-prefixed, e.g. "claude-code:abc-123"
    adapter: string;        // "claude-code" | "codex" | ...
    transcriptPath: string; // absolute path resolved by adapter
    cwd?: string;           // working dir if known
    tag?: string;           // user-provided name
    pid?: number;           // process holding session, if known
    lastSeen: string;       // ISO timestamp
    status: "active" | "idle" | "ended";
  };
  ```
- Concurrent-safe via `proper-lockfile` (or equivalent) on writes; reads always allowed.
- Stale entries: `lastSeen` older than 24h flips status to `ended`. Heartbeat by adapter `scan()`.

#### Cursor (`cursor.ts`)

- Opaque base64 string encoding `{ adapter, byteOffset, msgIndex }`.
- Adapter-specific decoding; core treats it opaquely and rejects on `adapter` mismatch.

#### Snapshot tiers (`snapshot.ts`)

- `raw`: array of raw messages from adapter (verbatim JSON objects).
- `structured`: normalized:
  ```ts
  type Structured = {
    sessionId: string;
    messageCount: number;
    lastUserMessage?: string;
    lastAssistantMessage?: string;
    currentTask?: string;       // best-effort heuristic from system/user msgs
    pendingToolCalls: ToolCall[];
    lastToolCalls: ToolCall[];  // last 5
    activity: "idle" | "thinking" | "tool-running"; // momentary; distinct from SessionEntry.status
  };
  ```
- `summary`: invokes Anthropic API. Model from env `AGENT_PEEK_SUMMARY_MODEL` (default `claude-haiku-4-5`). Requires `ANTHROPIC_API_KEY`. Prompt: "summarize what this agent is doing in 2-3 sentences." Cached by `(sessionId, cursor)` for 60s in process.

#### Engine (`engine.ts`)

- `peek(idOrSelector, opts)` — returns `{ snapshot, nextCursor }`.
- `list(filter)` — returns matched `SessionEntry[]`.
- `register(opts)` — adds explicit entry (tag, cwd, transcriptPath).
- `tag(id, name)` / `untag(id)`.
- `unregister(id)`.
- Selector resolution order: exact id → tag exact → cwd exact → cwd prefix; ambiguity throws `AmbiguousSelector`.

### Adapter API (`src/adapters/types.ts`)

```ts
export interface Adapter {
  name: string;                     // e.g. "claude-code"
  scan(): Promise<SessionEntry[]>;  // discover sessions on disk
  read(entry: SessionEntry, cursor?: Cursor): Promise<{
    messages: RawMessage[];
    nextCursor: Cursor;
    eof: boolean;
  }>;
  // optional, reserved for future live-tail support; not used in v1:
  watch?(entry: SessionEntry, onChange: () => void): () => void;
}
```

Loader: built-ins imported statically. External adapters discovered by scanning `process.env.AGENT_PEEK_ADAPTER_PATH` (colon-separated) plus globally-installed npm packages whose name matches `agent-peek-adapter-*` or `@<scope>/agent-peek-adapter-*`. External adapter exports default `Adapter`.

### Built-in adapters (`src/adapters/`)

- `claude-code/` — scans `~/.claude/projects/*/` for `*.jsonl`. Parses Claude Code transcript format. Cursor = byte offset into the file.
- `codex/` — research required for exact path/format (likely `~/.codex/sessions/` or similar JSONL). Same byte-offset cursor approach assumed.

### CLI (`src/cli/`)

- Built on `cac` (small, no dependencies beyond core).
- Commands: `peek`, `list`, `tag`, `untag`, `register`, `unregister`, `adapters`, `version`.
- Flags: `--mode raw|structured|summary`, `--since <cursor>`, `--json`, `--limit <n>`, `--adapter <name>`.
- Exit codes: 0 OK, 2 `SessionNotFound`, 3 `AmbiguousSelector`, 4 `AdapterError`, 5 config/env error.

### MCP server (`src/mcp/`)

- Uses `@modelcontextprotocol/sdk`.
- Tools exposed: `peek_session`, `list_sessions`, `tag_session`.
- Stdio transport (default). Started via `agent-peek-mcp` bin.
- No remote/TCP transport in v1 (same-user model).

### Layout

```
agent-peek/
├── src/
│   ├── core/
│   ├── adapters/
│   │   ├── claude-code/
│   │   └── codex/
│   ├── cli/
│   ├── mcp/
│   └── index.ts          # library entry
├── bin/
│   ├── peek.js
│   └── agent-peek-mcp.js
├── test/
└── package.json
```

`package.json`:
```json
{
  "name": "agent-peek",
  "exports": {
    ".": "./dist/index.js",
    "./adapter": "./dist/adapters/types.js",
    "./mcp": "./dist/mcp/index.js"
  },
  "bin": {
    "peek": "./bin/peek.js",
    "apeek": "./bin/peek.js",
    "agent-peek-mcp": "./bin/agent-peek-mcp.js"
  }
}
```

## Data Flow

### Flow A — passive scan + peek (zero setup)

```
agent A starts → writes ~/.claude/projects/<proj>/<uuid>.jsonl

agent B (peeker): peek list
  └─ engine.list()
     ├─ for each adapter: adapter.scan()
     │   └─ claude-code: glob ~/.claude/projects/*/*.jsonl, stat mtime
     ├─ merge into registry.json (lockfile guarded)
     └─ return entries sorted by lastSeen
  → CLI prints table: id | tag | adapter | cwd | status | lastSeen

agent B: peek peek <id> --mode structured
  └─ engine.peek(id, { mode: "structured" })
     ├─ registry lookup → entry
     ├─ adapter.read(entry, cursor=null)
     │   └─ claude-code: open jsonl, parse line-by-line
     ├─ snapshot.toStructured(messages)
     └─ return { snapshot, nextCursor }
  → stdout JSON or human format
```

### Flow B — explicit register + cursor diff

```
agent A starts: peek register --as researcher --transcript-path <p>
  └─ engine.register() adds entry with tag="researcher"

agent B turn 1: peek peek researcher --mode raw
  → returns 50 messages + cursor=c1 (byteOffset=4321)

agent A continues; transcript grows...

agent B turn 2: peek peek researcher --since c1 --mode raw
  └─ adapter.read(entry, cursor=c1)
     └─ seek to byteOffset 4321, parse only new lines
  → returns 7 new messages + cursor=c2 (byteOffset=5210)
```

### Flow C — MCP tool call (Claude Code agent peeking sibling)

```
Claude Code session B has agent-peek-mcp configured.
Agent thinks "let me check researcher's progress":
  └─ tool call: peek_session({ selector: "researcher", mode: "summary", since: "c1" })
     └─ MCP server → engine.peek(...)
        ├─ adapter.read with cursor c1
        ├─ snapshot.toSummary() → calls Haiku with delta only
        └─ returns { summary: "...", nextCursor: "c2", deltaMessageCount: 7 }
```

### Concurrency / race conditions

- Adapter reads transcript while writer (other Claude session) appends. Handled by:
  - Open read-only; read up to current EOF only.
  - JSONL line-aware parsing — partial trailing line (writer mid-flight) is discarded; cursor stays at last complete line offset.
- Registry writes serialized via `proper-lockfile`.

## Error Handling

| Error | Cause | Behavior |
|-------|-------|----------|
| `SessionNotFound` | Selector matches nothing | CLI exit 2 + suggest `peek list`. Library throws typed error. |
| `AmbiguousSelector` | Tag/cwd matches >1 session | CLI prints candidates, exit 3. Library throws with `candidates[]`. |
| `AdapterNotFound` | Entry references uninstalled adapter | Skipped in `list`; errors on `peek` with install hint. |
| `TranscriptUnreadable` | File deleted / permission denied | Mark entry `ended`; prune on next scan. |
| `TranscriptCorrupt` | JSONL parse fails mid-file | Read up to last good line; return partial + warning. |
| `RegistryLockTimeout` | Concurrent writers can't acquire lock | Retry 3x with jitter; then fail clearly. |
| `CursorMismatch` | Cursor adapter ≠ session adapter | Error; caller drops cursor and re-peeks fresh. |
| `SummaryUnavailable` | `--mode summary` but no API key | Auto-fallback to structured + stderr warning; library returns `{ snapshot, fallback: true }`. |

## Edge Cases

- **Transcript actively being written** — read up to current EOF, stop at last `\n`. Partial trailing line discarded; next peek with cursor picks it up.
- **Massive transcripts (100k+ msgs)** — `peek` without `--since` could blow memory. Default `--limit 200` for raw mode (configurable via env / flag). Structured/summary always operate on tail window.
- **Multiple sessions same cwd** — `list` returns all; selector by cwd warns ambiguous.
- **Symlinked transcript paths** — resolve real path; dedupe in registry.
- **Adapter throws** — caught by core, wrapped in `AdapterError`; other adapters still listed.
- **Clock skew** — `lastSeen` uses local clock only; never compared across machines (same-user model).
- **Registry file corrupt** — load failure → atomic backup to `registry.corrupt-<ts>.json`; start fresh; loud warning.
- **Bin name `peek` collides on PATH** — `apeek` always installed as alias; documented in README.

## Testing

1. **Unit (vitest)**
   - Cursor encode/decode round-trip.
   - Snapshot tier transformations (raw → structured normalization).
   - Registry CRUD with mocked fs.
   - Selector resolution (id / tag / cwd / ambiguous).
   - Lockfile contention with promise races.

2. **Adapter tests**
   - Each built-in adapter has fixtures in `test/fixtures/<adapter>/<scenario>/`.
   - Scenarios: empty session, mid-tool-call, multi-turn, corrupt last line, very long.
   - Adapter conformance suite — shared test runs same assertions against any adapter (helps external adapter authors).

3. **Integration**
   - Spawn fake "writer" process appending to JSONL while peeker runs concurrently. Assert no parse errors; cursor advances correctly.
   - CLI integration: spawn `peek list` / `peek peek` against fixture dirs; snapshot stdout.
   - MCP integration: connect MCP client to server, call `peek_session`, assert response shape.

4. **Smoke (manual / opt-in CI)**
   - Real Claude Code session running; `peek list` finds it; `peek peek <id>` returns plausible content.

CI matrix: Node 20 + 22 on macOS + Linux. Coverage target: ≥85% line coverage on `core/` and `adapters/`.

## Open Research Items (resolve during planning)

- Codex CLI transcript format and on-disk path.
- Whether `proper-lockfile` is the right concurrency primitive on macOS + Linux for this use case (alternatives: `flock`, custom).
- Best lightweight CLI lib (`cac` vs `commander`); leaning `cac`.
- MCP SDK version pinning strategy.

## Future (post-v1)

- Live tail (`watch` adapter capability + async iterator).
- Inbox / one-way leave-note messaging.
- Additional adapters: Cursor, Aider, generic JSONL.
- Vault sinks (Obsidian, etc.) as separate plugin packages.
- Web UI / dashboard.
- Cross-machine peek over auth'd transport.
