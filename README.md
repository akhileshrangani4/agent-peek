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
peek peek <id|tag|cwd>                    # full snapshot
peek peek <selector> --mode structured    # normalized fields
peek peek <selector> --mode summary       # LLM-summarized (needs ANTHROPIC_API_KEY)
peek peek <selector> --since <cursor>     # only new messages since prior peek
peek tag <id> researcher                  # give a session a friendly name
peek register --id ... --adapter ... --transcript-path ...
peek adapters
```

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

## External adapters

Set `AGENT_PEEK_ADAPTER_PATH` to a colon-separated list of paths to adapter modules. Each module's default export must implement the `Adapter` interface from `agent-peek/adapter`.

## Security

Same-user, same-machine only. There is no remote transport; access control is filesystem permissions. Read-only by design — `agent-peek` never writes to another session's transcript.

## License

MIT
