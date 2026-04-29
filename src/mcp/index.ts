// src/mcp/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createEngine, VERSION } from "../index.js";
import type { SessionEntry, SnapshotMode } from "../core/types.js";
import { displayNames } from "../core/names.js";

const tools = [
  {
    name: "peek_session",
    description: "Read a snapshot of another agent's chat session.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Session displayName, id, tag, or cwd." },
        mode: { type: "string", enum: ["raw", "structured", "brief", "summary"], default: "raw" },
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

export async function run(): Promise<void> {
  const engine = await createEngine({ withExternal: true });
  const server = new Server(
    { name: "agent-peek", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (name === "peek_session") {
      const r = await engine.peek(String(args.selector), {
        mode: (args.mode as SnapshotMode) ?? "raw",
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
    if (name === "tag_session") {
      await engine.tag(String(args.id), String(args.tag));
      return { content: [{ type: "text", text: "ok" }] };
    }
    throw new Error(`Unknown tool: ${name}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
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

function isTerminalAdapter(adapter: unknown): boolean {
  return adapter === "tmux" || adapter === "screen";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run();
}
