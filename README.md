# agent-peek

> Read-only peek into other AI agent chat sessions.

When you run multiple AI agents in parallel — sibling Claude Code sessions, an agent + a researcher, a fleet of task-runners — `agent-peek` lets one agent ask "what is the other agent doing right now?" without crosstalk and without re-reading the whole transcript every time.

## Install

```bash
npm i -g agent-peek
```

Provides three things:

- `peek` — CLI (alias: `apeek`)
- `agent-peek-mcp` — MCP server for Claude Code / Codex / any MCP client
- `agent-peek` — TypeScript library

## CLI

```bash
peek list                                 # show discovered sessions
peek list --adapter claude-code           # scan/list one adapter
peek list --all                           # include ended sessions
peek list --terminals                     # include tmux/screen terminal captures
peek list --ids                           # show raw session ids
peek list --json                          # include displayName selectors
peek list adapters                        # show installed adapters
peek doctor                               # show adapter availability and setup hints
peek ui                                   # interactive terminal browser
peek at <name|id|tag|cwd>                 # full snapshot
peek at <selector> --mode structured      # normalized fields
peek at <selector> --mode summary         # LLM-summarized (needs ANTHROPIC_API_KEY)
peek at <selector> --since <cursor>       # only new messages since prior peek
peek tag <id> as researcher               # give a session a friendly name
peek untag <id>
peek register <id> at <path> [--as <name>]
peek forget <id>
```

Default `peek list` output is compact and human-first:

```text
NAME               ADAPTER  STATUS  UPDATED  SOURCE  CWD
sessionseek-codex  codex    active  0s ago   file    ~/Documents/sessionseek/sessionseek
```

The `NAME` column is the selector to use with `peek at`. Raw ids stay available
with `peek list --ids`, and JSON output includes both `id` and `displayName`.

CLI failures are printed to stderr in a stable, agent-readable shape:

```text
error: session_not_found
message: No session matched selector: worker
hint: Use `peek list` to get the current displayName values.
next:
  - peek list
  - peek list --ids
exitCode: 2
```

## Agent-friendly behavior

- Commands avoid harness-specific assumptions. Selectors can be `displayName`,
  raw id, tag, or cwd.
- `peek list --json` and MCP `list_sessions` include `displayName`,
  `sourceType`, `cwd`, `status`, and raw `id`.
- `peek doctor` reports which adapters are ready, missing paths, require a
  command such as `sqlite3`, or are opt-in terminal capture adapters.
- Terminal capture adapters (`tmux`, `screen`) are excluded from default scans
  unless requested with `--terminals` or `--adapter tmux|screen`.

## MCP

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "agent-peek": { "command": "agent-peek-mcp" }
  }
}
```

Tools exposed: `peek_session`, `list_sessions`, `tag_session`.

## Library

```ts
import { createEngine } from "agent-peek";

const engine = await createEngine();
const sessions = await engine.list();
const r = await engine.peek("researcher", { mode: "summary" });
console.log(r.snapshot);
console.log(r.nextCursor);     // pass back as `since` next call
```

## Built-in adapters

- `claude-code` — reads `~/.claude/projects/*/<uuid>.jsonl`
- `codex` — reads OpenAI Codex CLI transcripts (`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`)
- `copilot-cli` — reads GitHub Copilot CLI session-state directories (`~/.copilot/session-state/*`)
- `gemini` — reads Gemini CLI transcripts (`~/.gemini/tmp/<project>/chats/session-*.json`)
- `goose` — reads Goose session records (`~/.local/share/goose/sessions/sessions.db`) with legacy JSONL fallback
- `opencode` — reads OpenCode filesystem storage (`~/.local/share/opencode/storage/{session,message,part}`)
- `screen` — captures GNU screen scrollback via `hardcopy -h`
- `tmux` — captures tmux pane output for any harness running in tmux

Terminal adapters are opt-in for default CLI/MCP listing because they capture
terminal scrollback, not structured agent transcript files. Use
`peek list --terminals` or `peek list --adapter tmux`.

## Terminal UI

The plain-text commands remain the stable automation surface. For interactive
browsing in a real terminal, use:

```bash
peek ui
peek ui --adapter codex
peek ui --all
peek ui --terminals
```

`peek ui` shows a session list plus a detail pane for the selected session. It
uses structured mode by default and can switch between:

- `structured` — current task, activity, last messages, pending tools, recent tools
- `raw` — recent transcript messages
- `summary` — LLM summary, when `ANTHROPIC_API_KEY` is configured

The detail pane also shows session metadata: raw id, adapter, source type,
status, tag, cwd, transcript path, and last update time. It intentionally does
not show cursors; cursors are for `peek at --since <cursor>`, JSON output,
MCP tools, and library callers that need incremental polling.

Keyboard controls:

- up/down or `j`/`k` — select a session
- Enter or Space — refresh the selected session detail
- `m` or Tab — switch detail mode
- `r` — rescan sessions
- `q` or Escape — exit

`peek ui` requires an interactive TTY. Use `peek list`, `peek at`, and
`peek at --json` for pipes, scripts, and agent harnesses.

## External adapters

Set `AGENT_PEEK_ADAPTER_PATH` to a colon-separated list of paths to adapter modules. Each module's default export must implement the `Adapter` interface from `agent-peek/adapter`.

## Security

Same-user, same-machine only. There is no remote transport; access control is filesystem permissions. Read-only by design — `agent-peek` never writes to another session's transcript.

## License

MIT
