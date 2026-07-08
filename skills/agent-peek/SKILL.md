---
name: agent-peek
description: Use this skill whenever the user wants an AI agent to inspect, monitor, summarize, or coordinate with other local AI agent sessions using agent-peek, peek CLI, or the agent-peek MCP server. This includes requests like "peek at what Codex was doing", "check the other agent", "set up agent-peek MCP", "configure MCP for Cursor/Codex/Claude/Gemini/Windsurf/Cline/VS Code", or "help agents share context without writing into each other's chats." The skill installs or verifies agent-peek, configures the right MCP shape for the current client, and uses read-only peek/list/tag commands safely.
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
   intent so other agents see the conflict before the first write lands.

6. Read a session with the smallest useful mode:

   ```bash
   peek at <name|id|tag|cwd> --mode structured
   peek at <name|id|tag|cwd> --mode brief
   peek at <name|id|tag|cwd> --mode summary
   ```

`summary` is local by default when no hosted provider is configured. Use
`brief` when you need deterministic, compact output with no LLM behavior.

## Choosing Commands

- Use `peek list` first; the `NAME` column is the friendly selector for `peek at`.
- Use `peek list --files` when you need a quick overview of active/recent file context.
- Use `peek coord . --writing` before writing; it filters to active writers and claims.
- Use `peek check <file>` for scriptable conflict checks. Exit `1` means wait or inspect.
- Use `peek check <file> --as <owner>` after claiming, so your own claim is ignored.
- Use `peek check --files-from <path|->` for a planned multi-file edit.
- Use `peek claim <file> --ttl 2m` before a planned write; add `--files-from <path|->` for bulk claims. Run `peek release <claim-id> --claim-id --json`, optionally with `--files-from <path|->` for partial release, or `peek release <file>` when done.
- Treat claims as cooperative local coordination, not authentication. `--as` is an unverified owner label for well-behaved agents.
- Use `peek at <selector> --mode structured --json` when another script or agent will parse the result.
- Use `peek at <selector> --mode brief` for a compact human-readable status.
- Use `peek at <selector> --mode summary` for a sentence-style local summary.
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

- `list_sessions`
- `peek_session`
- `coordination_digest`
- `tag_session`
- `post_to_feed`
- `read_feed`
- `expand_post`

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

## Response Pattern

When reporting findings to the user, include:

- Which session was inspected.
- Current task or last user request.
- Latest assistant status.
- Pending or recent tools, if relevant.
- Whether the session appears idle, thinking, or tool-running.

Keep it short unless the user asks for transcript detail.
