# agent-peek

[![npm version](https://img.shields.io/npm/v/agent-peek.svg)](https://www.npmjs.com/package/agent-peek)
[![license](https://img.shields.io/npm/l/agent-peek.svg)](./LICENSE)

Read-only visibility into your other AI agent sessions.

`agent-peek` lets one local agent ask what another local agent is doing without
writing into its transcript, stealing focus, or rereading the whole session on
every poll. It ships as a CLI, MCP server, and TypeScript library.

![agent-peek demo](https://raw.githubusercontent.com/akhileshrangani4/agent-peek/main/docs/demo.gif)

## Why

When you run multiple coding agents in parallel, each one normally works in its
own bubble. That leads to duplicated research, missed discoveries, and agents
editing around each other without context.

`agent-peek` gives them a shared read-only window:

- Humans can browse active sessions with `peek ui`.
- Agents can call `peek at <session> --json` or the MCP tools.
- Scripts can poll cheaply with cursors via `--since`.
- Session transcripts are never modified.

## Install

```bash
npm i -g agent-peek
```

Installed commands:

- `peek` — CLI
- `apeek` — alias for `peek`, useful if another tool owns that name
- `agent-peek-mcp` — MCP server for Claude Code, Codex, and other MCP clients

## Quick Start

List discovered sessions:

```bash
peek list
```

Open the interactive browser:

```bash
peek ui
```

Peek at a session by display name, id, tag, or cwd:

```bash
peek at researcher-codex --mode structured
```

Give a session a stable name:

```bash
peek tag researcher-codex as researcher
peek at researcher --mode summary
```

## CLI

Common commands:

```bash
peek list                                 # show discovered sessions
peek list --adapter claude-code           # scan/list one adapter
peek list --all                           # include ended sessions
peek list --terminals                     # include tmux/screen terminal captures
peek list --ids                           # show raw session ids
peek list --json                          # machine-readable list
peek list adapters                        # show installed adapters
peek doctor                               # adapter availability and setup hints

peek ui                                   # interactive terminal browser
peek ui --adapter codex
peek ui --all
peek ui --terminals

peek at <name|id|tag|cwd>                 # raw snapshot
peek at <selector> --mode structured      # normalized status/task/tool fields
peek at <selector> --mode summary         # LLM summary, requires ANTHROPIC_API_KEY
peek at <selector> --since <cursor>       # only messages since prior peek

peek tag <selector> as researcher
peek untag researcher
peek register <adapter:id> at <path> [--as <name>]
peek forget <id>
```

Default `peek list` output is compact and human-first:

```text
NAME               ADAPTER  STATUS  UPDATED  SOURCE  CWD
sessionseek-codex  codex    active  0s ago   file    ~/Documents/sessionseek/sessionseek
```

The `NAME` column is the selector to use with `peek at`. Raw ids stay available
with `peek list --ids`, and JSON output includes both `id` and `displayName`.

## Terminal UI

`peek ui` is for humans browsing in a real terminal. It shows a session list and
a detail pane for the selected session.

It starts in `structured` mode and can switch between:

- `structured` — current task, activity, last messages, pending tools, recent tools
- `raw` — recent transcript messages
- `summary` — LLM summary, when `ANTHROPIC_API_KEY` is configured

The detail pane shows useful metadata: raw id, adapter, source type, status,
tag, cwd, transcript path, and last update time. It intentionally does not show
cursors; cursors are for JSON/API callers that need incremental polling.

Keyboard controls:

- up/down or `j`/`k` — select a session
- Enter or Space — refresh the selected session detail
- `m` or Tab — switch detail mode
- `r` — rescan sessions
- `q` or Escape — exit

For pipes, scripts, and agent harnesses, use `peek list`, `peek at`, and
`peek at --json` instead of `peek ui`.

## Agent-Friendly Output

CLI failures are printed to stderr in a stable shape:

```text
error: session_not_found
message: No session matched selector: worker
hint: Use `peek list` to get the current displayName values.
next:
  - peek list
  - peek list --ids
exitCode: 2
```

Cursor polling lets an agent fetch only new messages after a prior peek:

```bash
peek at researcher --mode raw --json
peek at researcher --mode raw --since <nextCursor> --json
```

## MCP

Add the MCP server to your client config:

```json
{
  "mcpServers": {
    "agent-peek": { "command": "agent-peek-mcp" }
  }
}
```

Tools exposed:

- `list_sessions`
- `peek_session`
- `tag_session`

## Library

```ts
import { createEngine } from "agent-peek";

const engine = await createEngine();
const sessions = await engine.list();

const result = await engine.peek("researcher", { mode: "summary" });

console.log(result.snapshot);
console.log(result.nextCursor);
```

## Built-In Adapters

- `claude-code` — reads `~/.claude/projects/*/<uuid>.jsonl`
- `codex` — reads Codex CLI transcripts in `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`
- `copilot-cli` — reads GitHub Copilot CLI session-state directories in `~/.copilot/session-state/*`
- `gemini` — reads Gemini CLI transcripts in `~/.gemini/tmp/<project>/chats/session-*.json`
- `goose` — reads Goose session records in `~/.local/share/goose/sessions/sessions.db`
- `opencode` — reads OpenCode filesystem storage in `~/.local/share/opencode/storage/{session,message,part}`
- `screen` — captures GNU screen scrollback via `hardcopy -h`
- `tmux` — captures tmux pane output

Terminal adapters are opt-in for default CLI/MCP listing because they capture
terminal scrollback, not structured agent transcript files. Use
`peek list --terminals` or `peek list --adapter tmux`.

## External Adapters

Set `AGENT_PEEK_ADAPTER_PATH` to a colon-separated list of adapter modules.
Each module's default export must implement the `Adapter` interface from
`agent-peek/adapter`.

## Security Model

`agent-peek` is same-user, same-machine only.

- No remote transport is exposed by the package.
- Access control is your local filesystem permissions.
- Session access is read-only.
- `agent-peek` never writes to another agent's transcript.

## License

MIT
