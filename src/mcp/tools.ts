// src/mcp/tools.ts
//
// The one MCP tool registry. Each tool is defined here once: name, description, the
// JSON Schema clients have recorded, and a handler over the app services. The stdio
// server registers every tool; the future `/mcp` endpoint (D5) registers the ones not
// marked `localOnly`, rebound to its own services.
//
// The schemas stay JSON Schema literals rather than zod: `tools/list` output is a
// recorded contract (the golden suite projects it onto 0.6.0), and generating it from
// zod would reorder and add keys.
import type { App } from "../app/index.js";
import { projectAt } from "../app/project.js";
import { isSessionStatus, withDisplayNames, type SessionStatus } from "../app/sessions.js";
import {
  AmbiguousSelectorError, InvalidCursorError, NotAProjectError,
  PostNotFoundError, PostRejectedError, SessionNotFoundError,
} from "../core/errors.js";
import { HANDOFF_TARGETS, parseHandoffTarget } from "../core/handoff.js";
import type { SnapshotMode } from "../core/types.js";
import type { PostType } from "../feed/index.js";
import { ArchiveRefusedError } from "../skills/archive.js";
import {
  agentsTool, archivePlanTool, skillDetailTool, skillsTool, usageTool,
  DEFAULT_LIMIT, MAX_LIMIT,
} from "./skills.js";

export type ToolArgs = Record<string, unknown>;

// A type alias, not an interface: the MCP SDK's result type carries an index signature,
// which an alias satisfies implicitly and an interface does not.
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolContext {
  readonly app: Pick<App, "sessions" | "coordination" | "feed">;
  /**
   * The project directory a feed tool uses when the caller passes no `dir`. The stdio
   * server answers with its own working directory; a remote host has no meaningful one.
   */
  defaultDir(): string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
  /**
   * Reads transcripts or this machine's own state (skills, usage, tags). D5.2 keeps
   * these off any remote endpoint, which holds no transcript text and no machine state.
   */
  readonly localOnly: boolean;
  call(args: ToolArgs, ctx: ToolContext): Promise<ToolResult>;
}

/** What `tools/list` shows for a tool: the recorded keys, in the recorded order. */
export function toolListing(tool: ToolDefinition): { name: string; description: string; inputSchema: ToolInputSchema } {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

/**
 * Runs the named tool. An unknown name throws, which the MCP server reports as a
 * protocol error, as it always has.
 */
export function callTool(
  tools: readonly ToolDefinition[],
  name: string,
  args: ToolArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.call(args, ctx);
}

/** Tool results travel as one JSON text block. */
export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/**
 * Errors a caller can act on (a bad selector, cursor, post or project) come back as a
 * tool result the agent reads. Anything else is a fault in peek and stays a protocol
 * error, so it is never dressed up as an answer.
 */
export function toolErrorResult(error: unknown): ToolResult {
  if (error instanceof PostRejectedError || error instanceof PostNotFoundError || error instanceof NotAProjectError
      || error instanceof InvalidCursorError || error instanceof SessionNotFoundError
      || error instanceof AmbiguousSelectorError) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
  throw error;
}

function recoverable(
  handler: (args: ToolArgs, ctx: ToolContext) => Promise<ToolResult>,
): (args: ToolArgs, ctx: ToolContext) => Promise<ToolResult> {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx);
    } catch (error) {
      return toolErrorResult(error);
    }
  };
}

export function parseStatus(value: unknown): SessionStatus | undefined {
  if (value === undefined) return undefined;
  if (isSessionStatus(value)) return value;
  throw new Error(`invalid status: ${String(value)}`);
}

export function parseSnapshotMode(value: unknown): SnapshotMode {
  if (value === undefined) return "raw";
  if (value === "raw" || value === "structured" || value === "brief" || value === "summary" || value === "handoff") {
    return value;
  }
  throw new Error(`invalid mode: ${String(value)}`);
}

/** `first` and `last` are spellings of a raw window size; `limit` is the plain one. */
export function rawLimit(args: ToolArgs): number | undefined {
  if (typeof args.first === "number") return args.first;
  if (typeof args.last === "number") return args.last;
  if (typeof args.limit === "number") return args.limit;
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => String(v));
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : String(value);
}

function feedProject(args: ToolArgs, ctx: ToolContext) {
  return projectAt(args.dir ? String(args.dir) : ctx.defaultDir());
}

/**
 * `usage_report` arguments, copied field by field and never forwarded as an object:
 * `home` is a test-only parameter of `usageTool`, and passing a caller's arguments
 * through would let an MCP client point peek at an arbitrary directory tree.
 */
export function usageToolArgs(args: ToolArgs): Parameters<typeof usageTool>[0] {
  return {
    groupBy: optionalString(args.groupBy),
    skill: optionalString(args.skill),
    agent: optionalString(args.agent),
    adapter: optionalString(args.adapter),
    tool: optionalString(args.tool),
    allTools: args.allTools === true,
    sourceKind: optionalString(args.sourceKind),
    sidechain: typeof args.sidechain === "boolean" ? args.sidechain : undefined,
    attributionAgent: optionalString(args.attributionAgent),
    since: optionalString(args.since),
    until: optionalString(args.until),
    includeBuiltins: args.includeBuiltins === true,
    limit: typeof args.limit === "number" ? args.limit : undefined,
  };
}

const peekSession: ToolDefinition = {
  name: "peek_session",
  description: "Read a snapshot of another agent's chat session. For \"what is that agent doing\" use mode=brief or structured. mode=handoff does not spawn anything: the result's `material` string is a complete prompt (writing instructions and the eight section headings, heuristic hints, then the compressed transcript between `--- transcript ---` and `--- end transcript ---`); you are the harness, so answer that prompt yourself and the markdown you produce is the handoff. `document` in that result is only a regex stub.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "Session displayName, id, tag, or cwd." },
      mode: {
        type: "string",
        enum: ["raw", "structured", "brief", "summary", "handoff"],
        default: "raw",
        description: "raw: transcript messages (windowed). structured: stable fields (currentTask, activity, writingFiles, pending tools). brief: one-paragraph status; use this for \"what is that agent doing\". summary: prose. handoff: `material` for you to write a handoff document from.",
      },
      target: { type: "string", description: "handoff mode: who the handoff is for (generic, claude-code, codex, gemini, copilot, opencode, chatgpt, claude-chat). Chat targets get code inlined; CLI targets get paths." },
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
  localOnly: true,
  call: recoverable(async (args, { app }) => {
    const target = parseHandoffTarget(args.target);
    // A plain Error, so it stays a protocol error as it was in 0.6.
    if (!target) throw new Error(`Unknown handoff target: ${String(args.target)}. Use one of ${HANDOFF_TARGETS.join(", ")}.`);
    const result = await app.sessions.peek(String(args.selector), {
      mode: parseSnapshotMode(args.mode),
      target,
      produce: "material",
      since: args.since ? String(args.since) : undefined,
      limit: rawLimit(args),
      offset: typeof args.offset === "number" ? args.offset : undefined,
      around: typeof args.around === "number" ? args.around : undefined,
      from: typeof args.first === "number" ? "start" : "end",
      order: args.reverse === true ? "newest-first" : "oldest-first",
    });
    return jsonResult(result);
  }),
};

const listSessions: ToolDefinition = {
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
  localOnly: false,
  call: recoverable(async (args, { app }) => {
    const list = await app.sessions.list({
      adapter: args.adapter ? String(args.adapter) : undefined,
      status: parseStatus(args.status),
      includeEnded: args.includeEnded === true,
      includeTerminal: args.includeTerminal === true,
    });
    return jsonResult(withDisplayNames(list));
  }),
};

const coordinationDigest: ToolDefinition = {
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
  localOnly: false,
  call: recoverable(async (args, { app }) => {
    const digest = await app.coordination.digest({
      cwd: args.cwd ? String(args.cwd) : undefined,
      adapter: args.adapter ? String(args.adapter) : undefined,
      status: parseStatus(args.status),
      writingOnly: args.writingOnly === true,
      since: args.since ? String(args.since) : undefined,
      includeEnded: args.includeEnded === true,
      includeTerminal: args.includeTerminal === true,
    });
    return jsonResult(digest);
  }),
};

const tagSession: ToolDefinition = {
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
  localOnly: true,
  call: recoverable(async (args, { app }) => {
    await app.sessions.tag(String(args.id), String(args.tag));
    return { content: [{ type: "text", text: "ok" }] };
  }),
};

const postToFeed: ToolDefinition = {
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
  localOnly: false,
  call: recoverable(async (args, ctx) => {
    const post = await ctx.app.feed.post(feedProject(args, ctx), {
      type: String(args.type) as PostType,
      title: String(args.title),
      text: String(args.text),
      paths: stringArray(args.paths),
      topics: stringArray(args.topics),
      replyTo: args.reply_to ? String(args.reply_to) : undefined,
      supersedes: args.supersedes ? String(args.supersedes) : undefined,
      mentions: stringArray(args.mentions),
      ttlMs: typeof args.ttl_ms === "number" ? args.ttl_ms : undefined,
    }, { as: args.as ? String(args.as) : undefined });
    return jsonResult(post);
  }),
};

const readFeed: ToolDefinition = {
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
  localOnly: false,
  call: recoverable(async (args, ctx) => {
    const result = await ctx.app.feed.read(feedProject(args, ctx), {
      budget: typeof args.budget === "number" ? args.budget : undefined,
      contextPaths: stringArray(args.context_paths),
      since: args.since ? String(args.since) : undefined,
      types: args.types ? (stringArray(args.types) as PostType[]) : undefined,
      reader: args.reader ? String(args.reader) : undefined,
      includeDerived: typeof args.include_derived === "boolean" ? args.include_derived : undefined,
    });
    return jsonResult(result);
  }),
};

const expandPost: ToolDefinition = {
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
  localOnly: false,
  call: recoverable(async (args, ctx) => {
    const post = await ctx.app.feed.expand(feedProject(args, ctx), String(args.post_id));
    return jsonResult(post);
  }),
};

const usageReport: ToolDefinition = {
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
  localOnly: true,
  call: async (args) => jsonResult(await usageTool(usageToolArgs(args))),
};

const skillsReport: ToolDefinition = {
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
  localOnly: true,
  call: async (args) => jsonResult(await skillsTool({
    segment: optionalString(args.segment),
    limit: typeof args.limit === "number" ? args.limit : undefined,
  })),
};

const skillDetail: ToolDefinition = {
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
  localOnly: true,
  call: async (args) => {
    try {
      return jsonResult(await skillDetailTool({ skill: String(args.skill) }));
    } catch (error) {
      if (error instanceof ArchiveRefusedError) {
        return jsonResult({ refused: { reason: error.reason, message: error.message, detail: error.detail } });
      }
      throw error;
    }
  },
};

const archivePlan: ToolDefinition = {
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
  localOnly: true,
  call: async (args) => jsonResult(await archivePlanTool({
    skill: String(args.skill),
    agent: args.agent ? String(args.agent) : undefined,
    allAgents: args.allAgents === true,
  })),
};

const listAgents: ToolDefinition = {
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
  localOnly: true,
  call: async (args) => jsonResult(await agentsTool({ all: args.all === true })),
};

/** Every tool, in the order `tools/list` has always returned them. */
export const TOOLS: readonly ToolDefinition[] = [
  peekSession, listSessions, coordinationDigest, tagSession,
  postToFeed, readFeed, expandPost,
  usageReport, skillsReport, skillDetail, archivePlan, listAgents,
];
