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

const prompts = [
  {
    name: "coordinate-agents",
    description: "Check nearby agents before starting or continuing work.",
    arguments: [
      { name: "cwd", description: "Working directory to coordinate. Defaults to the current project.", required: false },
      { name: "since", description: "Coordination cursor from a prior digest.", required: false },
    ],
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

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const args = req.params.arguments ?? {};
    if (req.params.name === "coordinate-agents") {
      const cwd = typeof args.cwd === "string" ? args.cwd : undefined;
      const since = typeof args.since === "string" ? args.since : undefined;
      return promptText(
        "Coordinate nearby agents",
        [
          cwd
            ? `Call coordination_digest with cwd=${JSON.stringify(cwd)}${since ? ` and since=${JSON.stringify(since)}` : ""}.`
            : `Call coordination_digest${since ? ` with since=${JSON.stringify(since)}` : ""}; pass an absolute workspace cwd only if the client knows it.`,
          "Summarize high/medium overlapHints first, then who is active, what changed, session intent, activeWritingFiles, recentWritingFiles, pending tools, and hotFiles.",
          "If overlapHints mention a cwd or file you plan to touch, inspect the relevant session resource before editing.",
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
    const parsed = parseSessionResource(uri);
    if (!parsed) throw new Error(`Unknown resource: ${uri}`);
    const result = await readSessionResource(engine, parsed.selector, parsed.view);
    return jsonResource(uri, result);
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (name === "peek_session") {
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
    }
    if (name === "list_sessions") {
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
    }
    if (name === "coordination_digest") {
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
    }
    if (name === "tag_session") {
      await engine.tag(String(args.id), String(args.tag));
      return { content: [{ type: "text", text: "ok" }] };
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

if (import.meta.url === `file://${process.argv[1]}`) {
  void run();
}
