// src/mcp/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createEngine, VERSION } from "../index.js";
import type { PeekResult, SessionEntry, SnapshotMode } from "../core/types.js";
import { displayNames } from "../core/names.js";
import {
  AmbiguousSelectorError, InvalidCursorError, NotAProjectError,
  PostNotFoundError, PostRejectedError, SessionNotFoundError,
} from "../core/errors.js";
import { expandPost, postToFeed, readFeed } from "../feed/index.js";
import {
  usageTool, skillsTool, skillDetailTool, archivePlanTool, agentsTool,
  DEFAULT_LIMIT, MAX_LIMIT,
} from "./skills.js";
import { ArchiveRefusedError } from "../skills/archive.js";
import type { PostInput, PostType } from "../feed/index.js";

const tools = [
  {
    name: "peek_session",
    description: "Read a snapshot of another agent's chat session.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Session displayName, id, tag, or cwd." },
        mode: { type: "string", enum: ["raw", "structured", "brief", "summary", "handoff"], default: "raw" },
        since: { type: "string", description: "Cursor returned by a prior peek." },
        limit: { type: "number", description: "Max raw messages (default 200)." },
        first: { type: "number", description: "Show the first N raw messages." },
        last: { type: "number", description: "Show the last N raw messages." },
        around: { type: "number", description: "Show raw messages around this 1-based message number." },
        offset: { type: "number", description: "Skip N messages from the selected raw edge." },
        reverse: { type: "boolean", description: "Return raw messages newest-first." },
      },
      required: ["selector"],
    },
  },
  {
    name: "list_sessions",
    description: "List discovered agent sessions.",
    inputSchema: {
      type: "object",
      properties: {
        adapter: { type: "string" },
        status: { type: "string", enum: ["active", "idle", "ended"] },
        includeEnded: { type: "boolean", description: "Include ended sessions when status is not provided." },
        includeTerminal: { type: "boolean", description: "Include terminal capture adapters such as tmux and screen." },
      },
    },
  },
  {
    name: "coordination_digest",
    description: "Summarize nearby agent activity, changes since a prior digest, and possible overlap.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Working directory to summarize. Omit to include all active sessions." },
        adapter: { type: "string" },
        status: { type: "string", enum: ["active", "idle", "ended"] },
        writingOnly: { type: "boolean", description: "Only include sessions with recent write intent." },
        since: { type: "string", description: "Coordination cursor returned by a prior digest." },
        includeEnded: { type: "boolean", description: "Include ended sessions." },
        includeTerminal: { type: "boolean", description: "Include terminal capture adapters such as tmux and screen." },
      },
    },
  },
  {
    name: "tag_session",
    description: "Give a session a friendly tag for easier addressing.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        tag: { type: "string" },
      },
      required: ["id", "tag"],
    },
  },
];

const FEED_TOOLS = [
  {
    name: "post_to_feed",
    description: "Publish a token-budgeted context post (finding, intent, warning, question, answer, handoff, status) to this project's feed so other agents can ingest it instead of re-exploring.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["finding", "intent", "warning", "question", "answer", "handoff", "status"] },
        title: { type: "string", description: "Max 80 chars" },
        text: { type: "string", description: "Max ~150 tokens; link evidence instead of inlining" },
        dir: { type: "string", description: "Project directory; defaults to server cwd" },
        paths: { type: "array", items: { type: "string" }, description: "Repo-relative paths (required for finding/warning)" },
        topics: { type: "array", items: { type: "string" } },
        reply_to: { type: "string" },
        supersedes: { type: "string" },
        mentions: { type: "array", items: { type: "string" } },
        ttl_ms: { type: "number" },
        as: { type: "string", description: "Author identity override" },
      },
      required: ["type", "title", "text"],
    },
  },
  {
    name: "read_feed",
    description: "Read this project's context feed: posts from other agents ranked by relevance to your working set and packed to a token budget. Call before exploring the repo.",
    inputSchema: {
      type: "object",
      properties: {
        dir: { type: "string" },
        budget: { type: "number", description: "Token budget, default 600" },
        context_paths: { type: "array", items: { type: "string" }, description: "Paths you are working on (improves ranking)" },
        since: { type: "string", description: "Cursor from a prior read_feed" },
        types: { type: "array", items: { type: "string" } },
        reader: { type: "string", description: "Your session identity (boosts mentions)" },
        include_derived: { type: "boolean", description: "Include derived status/overlap posts, default true" },
      },
      required: [],
    },
  },
  {
    name: "expand_post",
    description: "Fetch one feed post in full, including evidence references, before trusting or acting on it.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string" },
        dir: { type: "string" },
      },
      required: ["post_id"],
    },
  },
  {
    name: "usage_report",
    description:
      "Which skills and tools have actually been invoked, across every agent, from peek's "
      + "durable index. Returns an envelope carrying the observed window, per-adapter "
      + "windows, and the agents peek cannot see — counts are meaningless without them.",
    inputSchema: {
      type: "object",
      properties: {
        groupBy: {
          type: "string",
          description: "Dimension(s), comma-separated: skill|tool|agent|adapter|day|cwd|sourceKind|sidechain|attributionAgent. Default skill.",
        },
        skill: { type: "string", description: "Only this skill or command name." },
        agent: { type: "string", description: "Only this agent slug." },
        adapter: { type: "string" },
        tool: { type: "string", description: "Only invocations of this tool. Default: skills only." },
        allTools: { type: "boolean", description: "Every tool, not just skills." },
        sourceKind: { type: "string", enum: ["tool_call", "slash_command"] },
        sidechain: { type: "boolean", description: "true for subagent calls only, false for main loop only." },
        attributionAgent: { type: "string", description: "Subagent type that made the call." },
        since: { type: "string", description: "ISO instant, inclusive." },
        until: { type: "string", description: "ISO instant, exclusive." },
        includeBuiltins: { type: "boolean", description: "Keep CLI built-ins like /clear, which are recorded but are not skills." },
        limit: { type: "number", description: `Rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      },
    },
  },
  {
    name: "skills_report",
    description:
      "Skill inventory segmented by what can honestly be acted on: archivable, unknown "
      + "usage, read-only, in use. Summary first with per-segment totals, then a capped "
      + "slice. Needs the usage index; without it, segments are withheld rather than "
      + "reporting every skill as unused.",
    inputSchema: {
      type: "object",
      properties: {
        segment: {
          type: "string",
          enum: ["archivable", "unknown-usage", "read-only", "in-use"],
          description: "Return rows for one segment only. Totals for every segment are always included.",
        },
        limit: { type: "number", description: `Rows per segment (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      },
    },
  },
  {
    name: "skill_detail",
    description:
      "One skill: its installations per agent, what archiving each would do, per-agent "
      + "usage coverage, and cost. Returns paths and flags, never SKILL.md content.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name or key, as returned by skills_report." },
      },
      required: ["skill"],
    },
  },
  {
    name: "archive_plan",
    description:
      "What archiving a skill WOULD do, plus the command a human runs to do it. Changes "
      + "nothing: peek exposes no tool that can archive, because dry-run-by-default works "
      + "by a person reading the plan.",
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string", description: "Skill name or key." },
        agent: { type: "string", description: "Limit to one agent's installation." },
        allAgents: { type: "boolean", description: "Retire from every mutable root." },
      },
      required: ["skill"],
    },
  },
  {
    name: "list_agents",
    description:
      "Coding agents peek knows: which are on this machine, whether each entry is verified "
      + "or sourced from a third-party table, and what peek can observe and attribute for each.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean", description: "Include agents peek knows of that are not installed here." },
      },
    },
  },
];

const prompts = [
  {
    name: "coordinate-agents",
    description: "Check nearby agents before starting or continuing work.",
    arguments: [],
  },
  {
    name: "session-handoff",
    description: "Prepare a concise handoff from another agent session.",
    arguments: [
      { name: "selector", description: "Session displayName, id, tag, or cwd.", required: true },
    ],
  },
  {
    name: "avoid-overlap",
    description: "Look for session overlap before editing files.",
    arguments: [
      { name: "cwd", description: "Working directory to inspect for overlap.", required: false },
    ],
  },
];

export async function run(): Promise<void> {
  const engine = await createEngine({ withExternal: true });
  const server = new Server(
    { name: "agent-peek", version: VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools, ...FEED_TOOLS] }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    if (req.params.name === "coordinate-agents") {
      return promptText(
        "Coordinate nearby agents",
        [
          "Before exploring this repository, call read_feed (budget 600) and treat the returned",
          "posts as trusted context from other agents, noting any [drifted] markers. Also call",
          "coordination_digest to check live overlap (active sessions, files currently being",
          "written) before editing files. Before finishing your task, call post_to_feed with type",
          "\"finding\" (what you learned that the next agent would otherwise rediscover) or",
          "\"handoff\" (state, next actions). Keep titles under 80 characters and bodies under 150",
          "tokens; reference concrete paths.",
        ].join("\n"),
      );
    }
    if (req.params.name === "session-handoff") {
      const selector = requirePromptArg(args, "selector");
      return promptText(
        `Handoff for ${selector}`,
        [
          `Read ${sessionResourceUri(selector, "handoff")} or call peek_session with mode="handoff".`,
          "Summarize decisions, touched files, open questions, current activity, and the next likely action.",
          "Do not infer progress beyond what the session data shows.",
        ].join("\n"),
      );
    }
    if (req.params.name === "avoid-overlap") {
      const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
      return promptText(
        "Avoid overlapping agent work",
        [
          cwd
            ? `Call coordination_digest with cwd=${JSON.stringify(cwd)}.`
            : "Call coordination_digest without cwd, or pass an absolute workspace cwd if the client knows it.",
          "Inspect high/medium overlapHints, activeWritingFiles, recentWritingFiles, and hotFiles before choosing files to edit.",
          "If another active session appears to be working in the same area, read its handoff before proceeding.",
        ].join("\n"),
      );
    }
    throw new Error(`Unknown prompt: ${req.params.name}`);
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const list = await activeSessions(engine);
    const named = withDisplayNames(list);
    return {
      resources: [
        {
          uri: "agent-peek://sessions",
          name: "agent-peek sessions",
          description: "Discovered active agent sessions with display names.",
          mimeType: "application/json",
        },
        {
          uri: "agent-peek://feed",
          name: "agent-peek feed",
          description: "This project's context feed, ranked and packed to a token budget.",
          mimeType: "application/json",
        },
        ...named.map((entry) => ({
          uri: sessionResourceUri(entry.id, "brief"),
          name: `${entry.displayName} brief`,
          description: `Brief status for ${entry.displayName}.`,
          mimeType: "application/json",
        })),
        ...named.map((entry) => ({
          uri: sessionResourceUri(entry.id, "handoff"),
          name: `${entry.displayName} handoff`,
          description: `Structured handoff for ${entry.displayName}.`,
          mimeType: "application/json",
        })),
        ...named.map((entry) => ({
          uri: sessionResourceUri(entry.id, "tail"),
          name: `${entry.displayName} tail`,
          description: `Raw tail for ${entry.displayName}.`,
          mimeType: "application/json",
        })),
      ],
    };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "agent-peek://session/{selector}/brief",
        name: "session brief",
        description: "Brief status for a session selector, id, tag, or display name.",
        mimeType: "application/json",
      },
      {
        uriTemplate: "agent-peek://session/{selector}/handoff",
        name: "session handoff",
        description: "Structured handoff for a session selector, id, tag, or display name.",
        mimeType: "application/json",
      },
      {
        uriTemplate: "agent-peek://session/{selector}/tail",
        name: "session tail",
        description: "Raw tail for a session selector, id, tag, or display name.",
        mimeType: "application/json",
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = String(req.params.uri);
    if (uri === "agent-peek://sessions") {
      const list = await activeSessions(engine);
      return jsonResource(uri, withDisplayNames(list));
    }
    if (uri === "agent-peek://feed") {
      const result = await readFeed({ dir: process.cwd(), budget: 600, engine });
      return jsonResource(uri, result);
    }
    const parsed = parseSessionResource(uri);
    if (!parsed) throw new Error(`Unknown resource: ${uri}`);
    const result = await readSessionResource(engine, parsed.selector, parsed.view);
    return jsonResource(uri, result);
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (name === "peek_session") {
      try {
        const r = await engine.peek(String(args.selector), {
          mode: parseSnapshotMode(args.mode),
          since: args.since ? String(args.since) : undefined,
          limit: rawLimit(args),
          offset: typeof args.offset === "number" ? args.offset : undefined,
          around: typeof args.around === "number" ? args.around : undefined,
          from: typeof args.first === "number" ? "start" : "end",
          order: args.reverse === true ? "newest-first" : "oldest-first",
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      } catch (error) {
        return feedToolError(error);
      }
    }
    if (name === "list_sessions") {
      try {
        const status = parseStatus(args.status);
        let list = await engine.list({
          adapter: args.adapter ? String(args.adapter) : undefined,
          status,
          includeTerminal: args.includeTerminal === true || isTerminalAdapter(args.adapter),
        });
        if (!status && args.includeEnded !== true) {
          list = list.filter((entry) => entry.status !== "ended");
        }
        return { content: [{ type: "text", text: JSON.stringify(withDisplayNames(list)) }] };
      } catch (error) {
        return feedToolError(error);
      }
    }
    if (name === "coordination_digest") {
      try {
        const digest = await engine.coordinate({
          cwd: args.cwd ? String(args.cwd) : undefined,
          adapter: args.adapter ? String(args.adapter) : undefined,
          status: parseStatus(args.status),
          writingOnly: args.writingOnly === true,
          since: args.since ? String(args.since) : undefined,
          includeEnded: args.includeEnded === true,
          includeTerminal: args.includeTerminal === true || isTerminalAdapter(args.adapter),
        });
        return { content: [{ type: "text", text: JSON.stringify(digest) }] };
      } catch (error) {
        return feedToolError(error);
      }
    }
    if (name === "tag_session") {
      try {
        await engine.tag(String(args.id), String(args.tag));
        return { content: [{ type: "text", text: "ok" }] };
      } catch (error) {
        return feedToolError(error);
      }
    }
    if (name === "post_to_feed") {
      try {
        const post = await postToFeed({
          dir: args.dir ? String(args.dir) : process.cwd(),
          engine,
          as: args.as ? String(args.as) : undefined,
          input: {
            type: String(args.type) as PostType,
            title: String(args.title),
            text: String(args.text),
            paths: stringArray(args.paths),
            topics: stringArray(args.topics),
            replyTo: args.reply_to ? String(args.reply_to) : undefined,
            supersedes: args.supersedes ? String(args.supersedes) : undefined,
            mentions: stringArray(args.mentions),
            ttlMs: typeof args.ttl_ms === "number" ? args.ttl_ms : undefined,
          } satisfies Omit<PostInput, "project" | "author">,
        });
        return { content: [{ type: "text", text: JSON.stringify(post) }] };
      } catch (error) {
        return feedToolError(error);
      }
    }
    if (name === "read_feed") {
      try {
        const result = await readFeed({
          dir: args.dir ? String(args.dir) : process.cwd(),
          engine,
          budget: typeof args.budget === "number" ? args.budget : undefined,
          contextPaths: stringArray(args.context_paths),
          since: args.since ? String(args.since) : undefined,
          types: args.types ? (stringArray(args.types) as PostType[]) : undefined,
          reader: args.reader ? String(args.reader) : undefined,
          includeDerived: typeof args.include_derived === "boolean" ? args.include_derived : undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return feedToolError(error);
      }
    }
    if (name === "expand_post") {
      try {
        const post = await expandPost({
          dir: args.dir ? String(args.dir) : process.cwd(),
          postId: String(args.post_id),
        });
        return { content: [{ type: "text", text: JSON.stringify(post) }] };
      } catch (error) {
        return feedToolError(error);
      }
    }
    if (name === "usage_report") {
      return json(await usageTool(args as Parameters<typeof usageTool>[0]));
    }
    if (name === "skills_report") {
      return json(await skillsTool(args as Parameters<typeof skillsTool>[0]));
    }
    if (name === "skill_detail") {
      try {
        return json(await skillDetailTool({ skill: String(args.skill) }));
      } catch (error) {
        if (error instanceof ArchiveRefusedError) {
          return json({ refused: { reason: error.reason, message: error.message, detail: error.detail } });
        }
        throw error;
      }
    }
    if (name === "archive_plan") {
      return json(await archivePlanTool({
        skill: String(args.skill),
        agent: args.agent ? String(args.agent) : undefined,
        allAgents: args.allAgents === true,
      }));
    }
    if (name === "list_agents") {
      return json(await agentsTool({ all: args.all === true }));
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function promptText(description: string, text: string): {
  description: string;
  messages: { role: "user"; content: { type: "text"; text: string } }[];
} {
  return {
    description,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
}

function requirePromptArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`Missing required prompt argument: ${name}`);
}

async function activeSessions(engine: Awaited<ReturnType<typeof createEngine>>): Promise<SessionEntry[]> {
  const list = await engine.list({ includeTerminal: false });
  return list.filter((entry) => entry.status !== "ended");
}

function sessionResourceUri(selector: string, view: "brief" | "handoff" | "tail"): string {
  return `agent-peek://session/${encodeURIComponent(selector)}/${view}`;
}

function parseSessionResource(uri: string): { selector: string; view: "brief" | "handoff" | "tail" } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "agent-peek:" || parsed.hostname !== "session") return undefined;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return undefined;
  const view = parts[1];
  if (view !== "brief" && view !== "handoff" && view !== "tail") return undefined;
  return { selector: decodeURIComponent(parts[0]!), view };
}

async function readSessionResource(
  engine: Awaited<ReturnType<typeof createEngine>>,
  selector: string,
  view: "brief" | "handoff" | "tail",
): Promise<PeekResult> {
  if (view === "brief") return engine.peek(selector, { mode: "brief" });
  if (view === "handoff") return engine.peek(selector, { mode: "handoff" });
  return engine.peek(selector, { mode: "raw", limit: 50 });
}

/** Tool results travel as one JSON text block, matching the existing tools. */
function json(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function jsonResource(uri: string, value: unknown): { contents: { uri: string; mimeType: string; text: string }[] } {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(value),
    }],
  };
}

function rawLimit(args: Record<string, unknown>): number | undefined {
  if (typeof args.first === "number") return args.first;
  if (typeof args.last === "number") return args.last;
  if (typeof args.limit === "number") return args.limit;
  return undefined;
}

function withDisplayNames<T extends { id: string; name?: string; tag?: string; adapter: string; cwd?: string }>(
  list: T[],
): (T & { displayName: string })[] {
  const names = displayNames(list);
  return list.map((entry, i) => ({ ...entry, displayName: names[i]! }));
}

function parseStatus(value: unknown): SessionEntry["status"] | undefined {
  if (value === undefined) return undefined;
  if (value === "active" || value === "idle" || value === "ended") return value;
  throw new Error(`invalid status: ${String(value)}`);
}

function parseSnapshotMode(value: unknown): SnapshotMode {
  if (value === undefined) return "raw";
  if (value === "raw" || value === "structured" || value === "brief" || value === "summary" || value === "handoff") {
    return value;
  }
  throw new Error(`invalid mode: ${String(value)}`);
}

function isTerminalAdapter(adapter: unknown): boolean {
  return adapter === "tmux" || adapter === "screen";
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => String(v));
}

function feedToolError(error: unknown): { isError: true; content: { type: "text"; text: string }[] } {
  if (error instanceof PostRejectedError || error instanceof PostNotFoundError || error instanceof NotAProjectError
      || error instanceof InvalidCursorError || error instanceof SessionNotFoundError
      || error instanceof AmbiguousSelectorError) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
  throw error;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run();
}
