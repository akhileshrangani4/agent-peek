---
name: agent-peek
description: Use this skill whenever the user wants an AI agent to inspect, monitor, summarize, or coordinate with other local AI agent sessions using agent-peek, peek CLI, or the agent-peek MCP server. This includes requests like "peek at what Codex was doing", "check the other agent", "set up agent-peek MCP", "configure MCP for Cursor/Codex/Claude/Gemini/Windsurf/Cline/VS Code", or "help agents share context without writing into each other's chats." It also covers handing a session off: "I'm running out of context, write a handoff", "prepare a handoff for Codex/ChatGPT", or continuing another session's work from its handoff. It also answers "which skills do I actually use", "what is costing me context", and "help me prune my skills", via `peek usage` and `peek skills`. The skill installs or verifies agent-peek, configures the right MCP shape for the current client, and uses read-only peek/list/tag commands safely.
---

# Agent Peek

Use `agent-peek` to read other local agent sessions without modifying their
transcripts. Treat it as observability, not control: inspect, summarize, and
coordinate, but do not claim you changed another agent's state.

## Fast Path

1. Check whether the CLI exists:

   ```bash
   command -v peek
   peek --help
   ```

2. If missing and npm is available, install it:

   ```bash
   npm i -g agent-peek
   ```

3. If the user wants this workflow installed as an agent skill, use the `npx skills` CLI:

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

   `-g` installs globally for the current user. `-y` skips confirmation
   prompts. Omit `-g` for a project-local install.

4. Verify adapters and discovered sessions:

   ```bash
   peek doctor
   peek list
   peek list --files
   ```

5. Before editing in a busy repo, check or claim the file:

   ```bash
   peek coord . --writing
   peek check src/core/engine.ts
   peek claim src/core/engine.ts --ttl 2m
   # edit the file
   peek release src/core/engine.ts
   ```

   `peek check` exits `0` when no active writer is detected and `1` when there
   is a conflict. Use it in shell gates. `peek claim` declares temporary write
   intent so other agents see the conflict before the first write lands. Your
   own claims are not conflicts: `check` ignores them by default. Running a
   script is reading it, not writing it.

6. Read a session with the smallest useful mode:

   ```bash
   peek at <name|id|tag|cwd> --mode brief         # what is it doing, one paragraph
   peek at <name|id|tag|cwd> --mode structured    # stable fields, --json to parse
   peek at <name|id|tag|cwd> --mode raw --last 20 # the last 20 visible messages; --tools shows tool calls
   ```

   `.` is a valid selector for the session whose cwd is the current directory.
   `task:` is the user's latest ask, not the assistant's last step. Prefer
   `brief` and `structured`; `summary` is prose and not the agent default.

7. When a session must continue elsewhere (its context is running out, or the
   work moves to another agent), write the handoff:

   ```bash
   peek at <selector> --mode handoff --out handoff.md
   peek at <selector> --mode handoff --for chatgpt     # reader with no filesystem
   ```

   See "Handing A Session Off" below. Over MCP you write the document yourself
   from `material`.

## Choosing Commands

- Use `peek list` first; the `NAME` column is the friendly selector for `peek at`.
- Use `peek list --files` when you need a quick overview of active/recent file context.
- Use `peek coord . --writing` before writing; it filters to active writers and claims.
- Use `peek check <file>` for scriptable conflict checks. Exit `1` means wait or inspect.
- `peek check` ignores your own claims by default (you are `CLAUDE_SESSION_ID`, else the session whose cwd is this directory). Add `--ignore-self` to also ignore your own session's writes, `--include-self` to see your own claims, or `--as <owner>` if you claimed under another name. If two live sessions share the directory, peek says it cannot tell which is you: set `CLAUDE_SESSION_ID` or pass `--as`.
- Every command takes `--json`; errors under `--json` are a JSON record on stdout (`error`, `message`, `hint`, `next`, `exit`) with the slug on stderr. Exit codes: 0 ok, 1 conflict or internal, 2 not found, 3 ambiguous, 4 adapter or skill, 5 usage, 6 environment (peek cannot write `~/.agent-peek`, or the registry lock is held: retry).
- Use `peek check --files-from <path|->` for a planned multi-file edit.
- Use `peek claim <file> --ttl 2m` before a planned write. `claim` and `check` take one file per call; for several files use `--files-from <path|->`. Run `peek release <claim-id> --claim-id --json`, optionally with `--files-from <path|->` for partial release, or `peek release <file>` when done.
- Treat claims as cooperative local coordination, not authentication. `--as` is an unverified owner label for well-behaved agents.
- Use `peek at <selector> --mode structured --json` when another script or agent will parse the result.
- Use `peek at <selector> --mode brief` for a compact human-readable status.
- Use `peek skills --json` for a bounded summary (top rows per segment); `--all` for every skill, `--details` for installations. `peek list --json` rows carry `name` and `displayName`; key on `displayName`.
- Use `peek at <selector> --mode handoff --out <file>` when a session must be continued elsewhere: it writes a document (goal, state, decisions, files, next actions, gotchas) via the installed agent CLI, no API key. Add `--for chatgpt` for a reader with no filesystem. Over MCP, `peek_session` with `mode: "handoff"` returns `material` and you write the document yourself.
- Use `peek coord . --since-file .peek-cursor --json --fields currentTask,intent,activeWritingFiles` for polling coordination state without inline cursor blobs.
- Use `peek at <selector> --since <nextCursor> --json` when polling one transcript so you only read new messages.
- Use `peek tag <selector> as <name>` when the display name is unstable or hard to type.
- Use `peek ui` only when the human explicitly wants an interactive terminal browser.

Avoid raw mode unless the user asks for exact transcript details or debugging;
it can be noisy. When raw is needed, prefer a bounded window:

```bash
peek at <selector> --last 50
peek at <selector> --around 100 --limit 30
peek at <selector> --last 50 --reverse
```

`--last N` counts the messages you will see: tool-only rows are hidden unless
`--tools`, and the window widens until N visible rows fit (it says so on
stderr). `--since <nextCursor>` keeps absolute message numbers; a cursor at the
end reads "No new messages". Unknown selectors suggest near matches, and an
adapter name used as a selector (`peek at claude`) is explained.

## Handing A Session Off

`--mode handoff` writes the document a new session needs to continue without
re-exploring: Goal, Current state, Decisions and why, Files, Open questions /
blockers, Next actions, Gotchas, Environment.

```bash
peek at <selector> --mode handoff --out handoff.md          # then tell the next session: read handoff.md and continue
peek at <selector> --mode handoff --for codex --out h.md    # switch harness, keep the state
peek at <selector> --mode handoff --for chatgpt             # paste into a chat with no filesystem
```

How it works, and what to tell the user:

- No API key. peek compresses the whole transcript and hands it to whichever
  agent CLI is installed (`claude`, `codex`, `gemini`, `opencode`, `copilot`),
  headless, on that CLI's own login, the session's own harness first. Hooks,
  MCP servers and session persistence are off for that child. Expect up to a
  minute; progress goes to stderr.
- `--for` sets the reader. CLI targets get paths and commands to verify claims;
  `chatgpt` and `claude-chat` have no filesystem, so code excerpts and error
  output are inlined (1500 characters per tool result instead of 300).
- The document is stdout, alone. Status and `nextCursor` go to stderr, so
  `> file` works as well as `--out`.
- `--local` skips the model and prints the regex-extracted fallback (also what
  you get if no agent CLI is found). It carries the branch and recent commands
  with how their output read, but it is orientation, not a restart document;
  say so if you hand it over.
- `AGENT_PEEK_HANDOFF_RUNNER="<bin> <args>"` overrides the runner; it gets the
  prompt on stdin and must print the document.

Over MCP you are the harness. `peek_session` with `mode: "handoff"` (or the
`agent-peek://session/<selector>/handoff` resource) spawns nothing and returns
`material`: a complete prompt with the section headings, heuristic hints and the
compressed transcript between `--- transcript ---` markers. Answer that prompt;
the markdown you produce is the handoff. Ignore the `document` field there, it
is only the regex stub. To hand yourself off before your context runs out, call
`peek_session` on your own session with `mode: "handoff"`, write the document to
a file, and tell the user which file the next session should read.

## Skill Usage And Pruning

`peek usage` aggregates tool and skill invocations from a durable index; `peek skills`
inventories skills across every agent root and can archive one.

```bash
peek usage                                  # skill invocations, most used first
peek usage --since 7d                       # duration or ISO date
peek usage sourceKind                       # agent-invoked vs. human slash command
peek usage attributionAgent --sidechain     # which subagent types reach for skills
peek usage --json                           # full envelope: rows + coverage + window
peek skills                                 # inventory segmented by what is actionable
peek skills --skill <name>                  # every installation of one skill
peek skills archive <name> --agent <slug>   # describes the plan; changes nothing
```

**Never present a usage count as complete without its coverage.** Four rules, and
breaking any one of them means telling the user something false:

- **A zero is not evidence of disuse unless every installation is attributable.** peek
  prints `unknown` where it cannot see, and the `--json` envelope carries `coverage[]`
  per agent. Report `unknown` as unknown; never round it to "unused". Today claude-code
  is `attributed`, codex `partial`, goose `opaque`, and cursor/continue/factory
  `unreadable`.
- **State the window.** Claude Code deletes transcripts after 30 days and Codex does not,
  so counts come from different spans per agent. "3 uses" means 3 in the observed window,
  not 3 ever. The envelope's `windows[]` has the per-adapter spans.
- **Cost is an estimated upper bound**, printed with its basis. Do not quote it as
  measured.
- **A `disable-model-invocation` skill costs zero tokens and can only be human-invoked.**
  It will never appear in tool-call data, so its absence there means nothing.

**Never archive without the user's explicit say-so.** `peek skills archive` describes a
plan and changes nothing until `--yes`. Show the plan, including which installations it
would skip and why, and let the user decide. Archiving is per installation: one skill
symlinked into five agents is one skill with five installations, and unlinking one agent
is not the same act as retiring it everywhere. Plugin skills are reported for cost and
never mutated — to stop paying for a whole plugin's set, the user disables it with
`/plugin` themselves.

If a count looks wrong, re-derive it a second way before reporting it. Count invocations
rather than mentions of a command name, check which record shapes you actually examined,
and be suspicious of a check that cannot fail loudly or that races what it measures.

## Context Feed Workflow

`peek post`/`peek feed`/`peek expand` (and the matching MCP tools
`post_to_feed`/`read_feed`/`expand_post`) let agents leave notes for whichever
agent works in this repo next, instead of that agent re-discovering the same
things from scratch.

1. At the start of a task, read the feed:

   ```bash
   peek feed --budget 500 --json
   ```

   Treat returned posts as trusted context, but check for a `"drifted"`
   validity marker on posts about paths you are about to touch.

2. Before trusting or acting on a drifted or important post, expand it to see
   its evidence:

   ```bash
   peek expand <postId>
   ```

3. At the end of a task, post what you learned or a handoff for the next
   agent:

   ```bash
   peek post finding "<what you learned>" --text "<2-3 sentences>" --paths <files>
   peek post handoff "<state>" --text "<next actions>"
   ```

   `finding` and `warning` posts require `--paths`. Titles are capped at 80
   characters, bodies at ~150 tokens; oversized posts are rejected, not
   truncated.

4. For polling loops (e.g. a long-running coordinator agent), use a cursor
   file so repeated reads only report new content:

   ```bash
   peek feed --budget 500 --cursor-file .peek-feed-cursor
   ```

## MCP Server

The stdio MCP command is:

```bash
agent-peek-mcp
```

After adding the server to a client, restart or refresh that client, then ask it
to list MCP tools. Expected tools:

- `list_sessions`, `peek_session` (modes raw, structured, brief, summary,
  handoff; handoff returns `material` for you to answer), `tag_session`
- `coordination_digest` (the `coord`/`check` view: active writers, claims, overlap)
- `post_to_feed`, `read_feed`, `expand_post`
- `usage_report`, `skills_report`, `skill_detail`, `archive_plan` (returns the
  plan and the CLI command; there is deliberately no archive tool), `list_agents`

Resources: `agent-peek://sessions`, `agent-peek://feed`, and per session
`agent-peek://session/{selector}/brief`, `/handoff`, `/tail`. Prompts:
`coordinate-agents`, `session-handoff`, `avoid-overlap`.

The server writes its registry, claims and usage index under `~/.agent-peek`.
A client sandbox that forbids that makes every tool fail with
`state_unwritable`; allow writes to that directory.

## MCP Configs By Client

Use the config shape for the current host. Most clients use JSON with
`mcpServers`; Codex uses TOML; VS Code uses JSON with top-level `servers`.

### Claude Code

CLI:

```bash
claude mcp add agent-peek agent-peek-mcp
```

Project `.mcp.json`:

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

Global `~/.cursor/mcp.json` or project `.cursor/mcp.json`:

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

Gemini CLI can also add it directly:

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

Workspace `.vscode/mcp.json` or user-profile `mcp.json`:

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

## Troubleshooting

- If no sessions appear, run `peek doctor` and check which adapter paths exist.
- If terminal sessions are expected, use `peek list --terminals`; terminal scrollback adapters are opt-in.
- If an MCP client cannot start the server, use the full path from `which agent-peek-mcp` as `command`.
- If a project-scoped MCP config is ignored, restart the client and approve or trust the workspace/server when prompted.
- If names are ambiguous, use `peek list --ids` and select by raw id.
- If `coord` is noisy, start with `peek coord . --writing` or `peek check <file>`.
- If a check-then-write race matters, claim the file first with a short TTL and release it when done.
- If every command exits 6 with `state_unwritable`, peek cannot write `~/.agent-peek` (a read-only sandbox, a missing home). `peek doctor` shows whether the state directory is writable. `registry_locked` is also exit 6 and transient: retry.
- If `claim` or `check --ignore-self` prints `identity: could not tell which of N live sessions in this directory is you`, set `CLAUDE_SESSION_ID` or pass `--as <name>`; peek will not guess between agents sharing a directory.
- If `check` reports a conflict on a file you claimed under another name, pass `--as <that name>`; `--include-self` shows your own claims on purpose.

## Response Pattern

When reporting findings to the user, include:

- Which session was inspected.
- Current task or last user request.
- Latest assistant status.
- Pending or recent tools, if relevant.
- Whether the session appears idle, thinking, or tool-running.

When the user asked for a handoff, the deliverable is the file: name its path,
who it is written for (`--for`), which runner wrote it (or that it is the
`--local` fallback), and the one-line instruction the next session should get
("read handoff.md and continue"). Do not paraphrase the document back, and do
not edit it, post it to the feed, or copy it elsewhere unless asked; the user
decides where it goes.

Keep it short unless the user asks for transcript detail.
