// src/mcp/index.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createEngine } from "../index.js";
import type { SnapshotMode } from "../core/types.js";

const tools = [
  {
    name: "peek_session",
    description: "Read a snapshot of another agent's chat session.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Session id, tag, or cwd." },
        mode: { type: "string", enum: ["raw", "structured", "summary"], default: "raw" },
        since: { type: "string", description: "Cursor returned by a prior peek." },
        limit: { type: "number", description: "Max raw messages (default 200)." },
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
    { name: "agent-peek", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (name === "peek_session") {
      const r = await engine.peek(String(args.selector), {
        mode: (args.mode as SnapshotMode) ?? "raw",
        since: args.since ? String(args.since) : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return { content: [{ type: "text", text: JSON.stringify(r) }] };
    }
    if (name === "list_sessions") {
      const list = await engine.list({
        adapter: args.adapter ? String(args.adapter) : undefined,
        status: args.status as any,
      });
      return { content: [{ type: "text", text: JSON.stringify(list) }] };
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

if (import.meta.url === `file://${process.argv[1]}`) {
  void run();
}
