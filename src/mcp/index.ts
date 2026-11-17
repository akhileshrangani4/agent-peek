// src/mcp/index.ts
//
// The stdio MCP server: tools from the shared registry, plus the prompts and resources
// only a local client uses. Every handler goes through the app services.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../index.js";
import { createApp } from "../app/index.js";
import { projectAt } from "../app/project.js";
import { withDisplayNames, type SessionView } from "../app/sessions.js";
import { callTool, toolListing, TOOLS, type ToolContext } from "./tools.js";

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
  const app = await createApp({ withExternal: true });
  // Feed tools and the feed resource fall back to the server's own directory: a local
  // client launches the server inside the project it is working on.
  const ctx: ToolContext = { app, defaultDir: () => process.cwd() };
  const server = new Server(
    { name: "agent-peek", version: VERSION },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(toolListing) }));
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
          `Call peek_session with mode="handoff" (or read ${sessionResourceUri(selector, "handoff")}).`,
          "The result's `material` field is a prompt plus the compressed transcript. You are the model that writes the handoff:",
          "follow the instructions in `material` and produce the markdown document it describes.",
          "Do not infer progress beyond what the transcript shows.",
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
    const named = withDisplayNames(await app.sessions.active());
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
      return jsonResource(uri, withDisplayNames(await app.sessions.active()));
    }
    if (uri === "agent-peek://feed") {
      const result = await app.feed.read(projectAt(ctx.defaultDir()), { budget: 600 });
      return jsonResource(uri, result);
    }
    const parsed = parseSessionResource(uri);
    if (!parsed) throw new Error(`Unknown resource: ${uri}`);
    const result = await app.sessions.view(parsed.selector, parsed.view);
    return jsonResource(uri, result);
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    return callTool(TOOLS, name, args, ctx);
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

function sessionResourceUri(selector: string, view: SessionView): string {
  return `agent-peek://session/${encodeURIComponent(selector)}/${view}`;
}

function parseSessionResource(uri: string): { selector: string; view: SessionView } | undefined {
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

function jsonResource(uri: string, value: unknown): { contents: { uri: string; mimeType: string; text: string }[] } {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(value),
    }],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void run();
}
