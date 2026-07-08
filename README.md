# agent-peek

[![npm version](https://img.shields.io/npm/v/agent-peek.svg)](https://www.npmjs.com/package/agent-peek)
[![license](https://img.shields.io/npm/l/agent-peek.svg)](./LICENSE)

The context feed your agents read before touching the repo. Plus read-only
visibility into every local agent session.

`agent-peek` gives your local coding agents a shared context feed: typed,
token-budgeted posts they write and read so the next agent ingests a small
ranked delta instead of re-exploring the repo. Underneath it, one agent can
ask what another is doing without writing into its transcript or rereading
the whole session on every poll. It ships as a CLI, MCP server, and
TypeScript library.

![agent-peek demo](https://raw.githubusercontent.com/akhileshrangani4/agent-peek/main/docs/demo.gif)

## Why

Every agent that starts work in a repo pays the same tax: it re-reads files,
re-traces where auth lives, re-discovers the footgun in the migration script,
and re-learns whatever the last agent already figured out an hour ago. Run
several agents in parallel, or in sequence across sessions, and that
exploration cost multiplies: each one re-derives the same facts from scratch.

Git worktrees solve a different problem. They isolate working directories so
agents don't stomp each other's uncommitted changes, but a fresh worktree
starts with zero memory: it has no idea what a parallel agent in another
worktree just learned, or what the last session on this branch already
figured out. Isolation is not context sharing.

`agent-peek`'s context feed is where that discovery gets written down once and
read many times. An agent posts a finding, a warning, a question, or a
handoff; the next agent, whatever worktree or terminal it is in, reads the
feed instead of re-exploring. Because reads are ranked, budgeted, and
cursor-based, catching up is a delta: you pull what changed since your last
read, not the whole history.

Underneath the feed sits a plain observation layer: read-only visibility into
what every local agent session is doing right now. That is what powers the
feed's automatic overlap warnings, and it is also available directly:

- Humans can browse active sessions with `peek ui`.
- Agents can call `peek at <session> --json` or the MCP tools.
- Scripts can poll cheaply with cursors via `--since`.
- Session transcripts are never modified.

For coordination that git worktrees genuinely don't cover, such as a shared
dev server, a migration two agents both plan to run, or a file that two
agents in two different worktrees still both intend to touch, `agent-peek`
also has cooperative `coord`/`check`/`claim` commands. They are advisory
signals, not locks.

## Install

```bash
npm i -g agent-peek
```

Installed commands:

- `peek`: CLI
- `apeek`: alias for `peek`, useful if another tool owns that name
- `agent-peek-mcp`: MCP server for Claude Code, Codex, and other MCP clients

## Quick Start

Post something before you dig in, then read what other agents already found:

```bash
peek post finding "Auth lives in middleware" \
  --text "verify.ts owns session checks; controllers assume it already ran" \
  --paths src/middleware/verify.ts

peek feed --budget 500
```

That's the core loop: post what you learn, read what others posted. See
[Context Feed](#context-feed) for the full output shape, post types, and TTLs.

Once you've read the feed, you can also look at what other sessions are doing
right now:

```bash
peek list
peek at researcher-codex --mode structured
peek tag researcher-codex as researcher
peek at researcher --mode brief
```

See [Observation](#observation) for every mode `peek at` supports, and
[Coordination](#coordination) for checking and claiming files before you
write.

## Context Feed

`peek post`, `peek feed`, and `peek expand` are the three commands behind the
loop from Quick Start:

- `peek post <type> <title> --text <body> --paths <files>`: publish a
  finding, warning, question, answer, intent, handoff, or status update to
  this project's feed.
- `peek feed --budget <n>`: read the feed, ranked by relevance and packed
  into a token budget.
- `peek expand <postId>`: show one post in full, with its evidence.

Worked example:

```bash
peek post finding "Auth lives in middleware" \
  --text "verify.ts owns session checks; controllers assume it already ran" \
  --paths src/middleware/verify.ts

peek feed --budget 500
```

```text
[finding] Auth lives in middleware (claude-code:9f21ac, 3s ago)
  verify.ts owns session checks; controllers assume it already ran
  paths: src/middleware/verify.ts
  id: 0mrbpv1sg-97d04557
nextCursor: eyJ2IjoxLCJ3IjoiMjAyNi0wNy0wOFQwNjo0ODoyMC4xNzZaIiwiZCI6W119
```

Post types, one line each:

| Type | Use it for | Default TTL |
| --- | --- | --- |
| `finding` | Something you learned that the next agent shouldn't have to re-discover. Requires `--paths`. | 30d |
| `warning` | A hazard or footgun in the code the next agent should know about. Requires `--paths`. | 14d |
| `question` | Something you need another agent or human to answer. | 7d |
| `answer` | A reply to a `question` post (use `--reply-to <id>`). | 30d |
| `intent` | What you are about to do, so others can avoid stepping on it. | 8h |
| `handoff` | State and next actions for whoever picks this task up. | 7d |
| `status` | A pathless, short-lived update. | 10m |

Budget rules the feed enforces: titles are capped at 80 characters, authored
post bodies are capped at ~150 tokens (derived posts at ~40), and posts that
exceed either limit are rejected outright, not silently truncated. `peek
feed` packs the highest-ranked posts into your `--budget` and reports how
many were omitted so you can raise the budget or `peek expand` a specific
post.

### Feed in your agent's startup

Claude Code (`.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "peek feed --budget 500 2>/dev/null || true" }] }
    ]
  }
}
```

CLAUDE.md / AGENTS.md paragraph:

```markdown
Before starting work in this repo, run `peek feed --budget 500` and treat the posts as
context from other agents. Before finishing, run
`peek post finding "<what you learned>" --text "<2-3 sentences>" --paths <files>`.
```

## Observation

This is the read-only layer the feed's derived posts, like automatic overlap
warnings, are built on. It's also available directly, for humans in a
terminal and for agents that want to check on a session without touching the
feed.

List discovered sessions:

```bash
peek list
```

Common `peek list` flags:

```bash
peek list                                 # show discovered sessions
peek list --adapter claude-code           # scan/list one adapter
peek list --all                           # include ended sessions
peek list --terminals                     # include tmux/screen terminal captures
peek list --ids                           # show raw session ids
peek list --files                         # show active/recent file context
peek list --json                          # machine-readable list
peek list adapters                        # show installed adapters
```

Default `peek list` output is compact and human-first:

```text
NAME               ADAPTER  STATUS  UPDATED  SOURCE  CWD
sessionseek-codex  codex    active  0s ago   file    ~/Documents/sessionseek/sessionseek
```

The `NAME` column is the selector to use with `peek at`. Raw ids stay available
with `peek list --ids`, and JSON output includes both `id` and `displayName`.

Peek at a session by display name, id, tag, or cwd:

```bash
peek at researcher-codex --mode structured
```

`peek at` supports five scriptable output modes:

| Mode | Use it for | API key |
| --- | --- | --- |
| `raw` | Reading transcript messages directly. Best for debugging or inspecting exactly what happened. | No |
| `structured` | Stable fields for agents: current task, activity, last messages, pending tools, recent tools. | No |
| `brief` | A compact local summary built from structured fields. Good default for humans and scripts that do not need raw logs. | No |
| `handoff` | Local structured handoff: decisions, open questions, next actions, touched files, and tools. | No |
| `summary` | Optional sentence-style summary. De-emphasized for agent loops; prefer `brief` unless you explicitly need prose. Can use Anthropic when configured. | No |

```bash
peek at researcher-codex --mode brief
peek at researcher-codex --mode handoff
```

Raw mode has pagination controls:

```bash
peek at researcher --first 25
peek at researcher --last 100
peek at researcher --last 100 --offset 100
peek at researcher --around 250 --limit 40
peek at researcher --last 50 --reverse
```

By default, raw mode hides tool-only messages and tool-call status lines to keep
the output readable. Add `--tools` or `--verbose` when you need that detail.

`summary` is available for prose summaries, but it is not the recommended
agent-facing default. Prefer `brief` for low-latency local inspection. Summaries
are local by default. To use hosted LLM summaries (requires `ANTHROPIC_API_KEY`),
set:

```bash
AGENT_PEEK_SUMMARY_PROVIDER=anthropic
```

Give a session a stable name so you don't have to retype the generated one:

```bash
peek tag researcher-codex as researcher
peek at researcher --mode brief
```

Cursor polling lets an agent fetch only new messages after a prior peek:

```bash
peek at researcher --mode raw --json
peek at researcher --mode raw --since <nextCursor> --json
```

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

### Terminal UI

`peek ui` is for humans browsing in a real terminal. It shows a session list and
a detail pane for the selected session.

```bash
peek ui
peek ui --adapter codex
peek ui --all
peek ui --terminals
```

It starts in `structured` mode. Press `m` or Tab to cycle through:

- `structured`: current task, activity, last messages, pending tools, recent tools
- `brief`: compact local summary, no API key
- `timeline`: chronological role/text timeline for quick scanning
- `raw`: recent transcript messages
- `summary`: optional sentence-style summary

There is no separate command-line flag for timeline yet; open `peek ui`, then
press `m`/Tab until the header shows `mode=timeline`.

The detail pane shows useful metadata: raw id, adapter, source type, status,
tag, cwd, transcript path, and last update time. It intentionally does not show
cursors; cursors are for JSON/API callers that need incremental polling.

Keyboard controls:

- up/down or `j`/`k`: select a session
- Enter or Space: refresh the selected session detail
- `m` or Tab: switch detail mode
- `r`: rescan sessions
- `q` or Escape: exit

For pipes, scripts, and agent harnesses, use `peek list`, `peek at`, and
`peek at --json` instead of `peek ui`.

Other useful commands:

```bash
peek help                                 # focused command overview
peek version                              # installed version
peek update                               # update global install from npm
peek update --check                       # check latest version without installing
peek doctor                               # adapter availability and setup hints
peek register <adapter:id> at <path> [--as <name>]
peek forget <id>
peek untag researcher
```

## Coordination

Git worktrees already give each agent its own working directory, so file
conflicts inside a single git-tracked checkout usually aren't the problem.
What worktrees don't cover: a shared dev server, a database migration two
agents both plan to run, a shared external resource, or a file that two
agents in two different worktrees still both intend to touch. For that,
`agent-peek` has cooperative, advisory signals.

```bash
peek coord
peek coord . --writing
peek check src/core/engine.ts
peek claim src/core/engine.ts --ttl 2m --as codex-main
peek release <claim-id> --claim-id --json
```

Useful details:

- `peek coord . --writing` shows active writers and file claims, hiding idle noise.
- `peek list --files` gives the same file-context view as part of a regular session list.
- `peek check <file>` exits `0` when clear and `1` on conflict.
- `peek check --files-from changed-files.txt` bulk-checks a planned edit.
- `peek check <file> --as <owner>` ignores your own claims in claim-then-check loops.
- `peek claim <file> --ttl 2m` broadcasts temporary write intent (2m is the default TTL if you omit `--ttl`).
- `peek release <claim-id> --claim-id --files-from done-files.txt` partially releases a claim.
- `peek coord . --since-file .peek-cursor --json --fields currentTask,intent,activeWritingFiles` is the polling-friendly JSON path.

Claims are cooperative local signals, not authentication or access control.
Use them to help well-behaved agents avoid overlap on the things worktrees
don't isolate.

## MCP

The MCP server command is:

```bash
agent-peek-mcp
```

Exposed tools:

- `list_sessions`: list discovered sessions with display names.
- `peek_session`: read one session snapshot.
- `coordination_digest`: summarize nearby session activity and overlap.
- `tag_session`: assign a stable tag.
- `post_to_feed`: publish a context post to this project's feed.
- `read_feed`: read the feed, ranked and packed to a token budget.
- `expand_post`: show one feed post in full, with evidence references.

Exposed resources:

- `agent-peek://sessions`: active sessions as JSON.
- `agent-peek://feed`: this project's context feed, ranked and packed to a token budget.
- `agent-peek://session/{selector}/brief`: brief snapshot for one session.
- `agent-peek://session/{selector}/handoff`: handoff snapshot for one session.
- `agent-peek://session/{selector}/tail`: raw tail for one session.

The `agent-peek://feed` resource always serves the feed for the MCP server's
own working directory, not the caller's. Launch the server from the project
whose feed you want (or configure your client to set its `cwd`), or use the
`read_feed` tool with an explicit `dir` argument instead of the resource.

Exposed prompts:

- `coordinate-agents`: check nearby agents before continuing work.
- `session-handoff`: prepare a concise handoff from one session.
- `avoid-overlap`: inspect overlap hints before editing files.

It is a local stdio server. Different clients use different config shapes.

### Claude Code

Add it from the CLI:

```bash
claude mcp add agent-peek agent-peek-mcp
```

Or add a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "agent-peek": {
      "command": "agent-peek-mcp"
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-peek]
command = "agent-peek-mcp"
```

### Cursor

Add to global `~/.cursor/mcp.json` or project `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-peek": {
      "command": "agent-peek-mcp"
    }
  }
}
```

### Windsurf

Add to `~/.codeium/mcp_config.json`:

```json
{
  "mcpServers": {
    "agent-peek": {
      "command": "agent-peek-mcp"
    }
  }
}
```

### Gemini CLI

Add to user `~/.gemini/settings.json` or project `.gemini/settings.json`:

```json
{
  "mcpServers": {
    "agent-peek": {
      "command": "agent-peek-mcp"
    }
  }
}
```

Or use Gemini's MCP command:

```bash
gemini mcp add agent-peek agent-peek-mcp
```

### Cline

Cline CLI uses `~/.cline/data/settings/cline_mcp_settings.json`. The VS Code
extension opens its own `cline_mcp_settings.json` from the MCP Servers settings.

```json
{
  "mcpServers": {
    "agent-peek": {
      "command": "agent-peek-mcp",
      "disabled": false
    }
  }
}
```

### VS Code

VS Code uses top-level `servers`, not `mcpServers`. Add to workspace
`.vscode/mcp.json` or your user-profile `mcp.json`:

```json
{
  "servers": {
    "agent-peek": {
      "type": "stdio",
      "command": "agent-peek-mcp"
    }
  }
}
```

Config references: [Claude Code](https://code.claude.com/docs/en/mcp),
[Codex](https://developers.openai.com/codex/config-reference),
[Cursor](https://docs.cursor.com/advanced/model-context-protocol),
[Windsurf](https://docs.windsurf.com/plugins/cascade/mcp),
[Gemini CLI](https://geminicli.com/docs/tools/mcp-server/),
[Cline](https://docs.cline.bot/cline-cli/configuration), and
[VS Code](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration).

## Agent Skill

This repo includes an installable skill at `skills/agent-peek`. Use it when you
want another agent to learn the `peek` workflow and the MCP configs above.

Install it with the `npx skills` CLI:

```bash
npx skills add akhileshrangani4/agent-peek
```

The installer is interactive and will guide scope/agent choices. For a
non-interactive global install:

```bash
npx skills add akhileshrangani4/agent-peek --skill agent-peek -g -y
```

To target specific agents non-interactively:

```bash
npx skills add akhileshrangani4/agent-peek --skill agent-peek -a codex -a claude-code -g -y
```

Flags: `-g` installs globally for your user, and `-y` skips confirmation
prompts. Omit `-g` if you only want the skill installed into the current
project.

The skill teaches agents to:

- install or verify `agent-peek`
- run `peek doctor`, `peek list`, and bounded `peek at` commands
- configure MCP for Claude Code, Codex, Cursor, Windsurf, Gemini CLI, Cline, and VS Code
- report what another session is doing without modifying that session

## Library

```ts
import { createEngine } from "agent-peek";

const engine = await createEngine();
const sessions = await engine.list();

const result = await engine.peek("researcher", { mode: "brief" });
const firstPage = await engine.peek("researcher", { mode: "raw", from: "start", limit: 50 });

console.log(result.snapshot);
console.log(result.nextCursor);
```

## Adapters

### Built-in

- `claude-code`: reads `~/.claude/projects/*/<uuid>.jsonl`
- `codex`: reads Codex CLI transcripts in `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`
- `copilot-cli`: reads GitHub Copilot CLI session-state directories in `~/.copilot/session-state/*`
- `gemini`: reads Gemini CLI transcripts in `~/.gemini/tmp/<project>/chats/session-*.json`
- `goose`: reads Goose session records in `~/.local/share/goose/sessions/sessions.db`
- `opencode`: reads OpenCode filesystem storage in `~/.local/share/opencode/storage/{session,message,part}`
- `screen`: captures GNU screen scrollback via `hardcopy -h`
- `tmux`: captures tmux pane output

Terminal adapters are opt-in for default CLI/MCP listing because they capture
terminal scrollback, not structured agent transcript files. Use
`peek list --terminals` or `peek list --adapter tmux`.

### External

Set `AGENT_PEEK_ADAPTER_PATH` to a colon-separated list of adapter modules.
Each module's default export must implement the `Adapter` interface from
`agent-peek/adapter`.

## Security Model

`agent-peek` is same-user, same-machine only.

- No remote transport is exposed by the package.
- Access control is your local filesystem permissions.
- Session access is read-only.
- `agent-peek` never writes to another agent's transcript.
- Feed posts are stored persistently in `~/.agent-peek/feed/<project>.db`,
  protected only by your file permissions, and expire per-type on a TTL
  rather than being deleted immediately.
- `read_feed` and derived status posts surface other local sessions' current
  task and the files they are writing to any local reader; treat the feed as
  visible to anyone who can run `peek` or the MCP server as your user.
- Transcripts themselves remain read-only and unmodified; the feed database
  is the only place `agent-peek` writes data of its own.

## License

MIT
