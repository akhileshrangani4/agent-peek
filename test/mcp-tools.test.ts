// test/mcp-tools.test.ts
//
// The MCP tool registry, driven in-process. The golden suite proves the stdio wire
// format against 0.6.0 through the built binary; this proves the registry itself: its
// shape, the localOnly split D5.2 builds on, argument parsing, and that each handler
// answers through the app services it is handed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appFor } from "../src/app/index.js";
import { fixedClock } from "../src/app/time.js";
import { SessionNotFoundError } from "../src/core/errors.js";
import {
  TOOLS, callTool, jsonResult, parseSnapshotMode, parseStatus, rawLimit, toolErrorResult, toolListing,
  type ToolContext, type ToolResult,
} from "../src/mcp/tools.js";
import { makeTmpHome, withEnv } from "./helpers/tmp-home.js";
import { fakeAdapter, fixtureEngine, userTurn } from "./app/fixtures.js";

const NOW = "2026-11-13T12:00:00.000Z";

/** The JSON a tool result carries; fails loudly when the result is an error. */
function body<T = Record<string, unknown>>(result: ToolResult): T {
  expect(result.isError).toBeUndefined();
  expect(result.content).toHaveLength(1);
  return JSON.parse(result.content[0]!.text) as T;
}

describe("registry shape", () => {
  it("lists the twelve 0.6 tools in their recorded order, each once", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "peek_session", "list_sessions", "coordination_digest", "tag_session",
      "post_to_feed", "read_feed", "expand_post",
      "usage_report", "skills_report", "skill_detail", "archive_plan", "list_agents",
    ]);
  });

  it("shows only the recorded keys in tools/list, and every required argument is declared", () => {
    for (const tool of TOOLS) {
      expect(Object.keys(toolListing(tool))).toEqual(["name", "description", "inputSchema"]);
      expect(tool.inputSchema.type).toBe("object");
      for (const name of tool.inputSchema.required ?? []) {
        expect(tool.inputSchema.properties, `${tool.name}.${name}`).toHaveProperty(name);
      }
    }
  });

  it("marks every transcript- or machine-state tool localOnly, leaving no raw mode remotely", () => {
    const remote = TOOLS.filter((tool) => !tool.localOnly).map((tool) => tool.name);
    expect(remote).toEqual(["list_sessions", "coordination_digest", "post_to_feed", "read_feed", "expand_post"]);
    for (const tool of TOOLS.filter((t) => !t.localOnly)) {
      expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("mode");
    }
  });

  it("throws on an unknown tool name, which the server reports as a protocol error", () => {
    const ctx = { app: {}, defaultDir: () => "/" } as unknown as ToolContext;
    expect(() => callTool(TOOLS, "no_such_tool", {}, ctx)).toThrow("Unknown tool: no_such_tool");
  });
});

describe("argument and result rules", () => {
  it("parses a status, and refuses one that is not a session status", () => {
    expect(parseStatus(undefined)).toBeUndefined();
    expect(parseStatus("idle")).toBe("idle");
    expect(() => parseStatus("sleeping")).toThrow("invalid status: sleeping");
  });

  it("defaults the snapshot mode to raw, and refuses an unknown one", () => {
    expect(parseSnapshotMode(undefined)).toBe("raw");
    for (const mode of ["raw", "structured", "brief", "summary", "handoff"]) expect(parseSnapshotMode(mode)).toBe(mode);
    expect(() => parseSnapshotMode("tail")).toThrow("invalid mode: tail");
  });

  it("reads a raw window size from first, then last, then limit", () => {
    expect(rawLimit({ first: 1, last: 2, limit: 3 })).toBe(1);
    expect(rawLimit({ last: 2, limit: 3 })).toBe(2);
    expect(rawLimit({ limit: 3 })).toBe(3);
    expect(rawLimit({ limit: "3" })).toBeUndefined();
  });

  it("returns one JSON text block, and turns only caller-actionable errors into tool errors", () => {
    expect(jsonResult({ a: 1 })).toEqual({ content: [{ type: "text", text: "{\"a\":1}" }] });
    expect(toolErrorResult(new SessionNotFoundError("ghost"))).toMatchObject({ isError: true });
    const fault = new Error("peek is broken");
    expect(() => toolErrorResult(fault)).toThrow(fault);
  });
});

describe("handlers over the app services", () => {
  let home: string;
  let projectDir: string;
  let cleanup: () => Promise<void>;
  let ctx: ToolContext;
  let restoreHome: (() => void) | undefined;

  beforeEach(async () => {
    ({ home, cleanup } = await makeTmpHome());
    projectDir = join(home, "project");
    mkdirSync(projectDir);
    const engine = fixtureEngine(home, [fakeAdapter([
      { id: "worker", cwd: projectDir, name: "worker", messages: [userTurn("Fix the cache.")] },
      { id: "done", cwd: projectDir, status: "ended" },
    ])]);
    ctx = { app: appFor(engine, { clock: fixedClock(NOW), home }), defaultDir: () => projectDir };
    // The skills and usage tools read the user's home; point it at the temp home.
    const previous = process.env.HOME;
    process.env.HOME = home;
    restoreHome = () => { process.env.HOME = previous; };
  });
  afterEach(async () => {
    restoreHome?.();
    await cleanup();
  });

  const call = (name: string, args: Record<string, unknown> = {}) =>
    withEnv({ CLAUDE_SESSION_ID: "" }, () => callTool(TOOLS, name, args, ctx));

  it("lists sessions with display names, honouring status", async () => {
    const live = body<{ id: string; displayName: string }[]>(await call("list_sessions"));
    expect(live.map((s) => s.id)).toEqual(["fake:worker"]);
    expect(live[0]!.displayName).toEqual(expect.any(String));
    const ended = body<{ id: string }[]>(await call("list_sessions", { status: "ended" }));
    expect(ended.map((s) => s.id)).toEqual(["fake:done"]);
    await expect(call("list_sessions", { status: "sleeping" })).rejects.toThrow("invalid status");
  });

  it("peeks a session, and answers a bad selector as a tool error", async () => {
    const brief = body<{ snapshot?: unknown; messages?: unknown }>(await call("peek_session", { selector: "fake:worker", mode: "structured" }));
    expect(JSON.stringify(brief)).toContain("Fix the cache.");
    const missing = await call("peek_session", { selector: "ghost" });
    expect(missing.isError).toBe(true);
    await expect(call("peek_session", { selector: "fake:worker", mode: "handoff", target: "fax" }))
      .rejects.toThrow("Unknown handoff target: fax");
  });

  it("tags a session so it can be addressed by the tag", async () => {
    expect(await call("tag_session", { id: "fake:worker", tag: "cache" })).toEqual({ content: [{ type: "text", text: "ok" }] });
    const sessions = body<{ id: string; tag?: string }[]>(await call("list_sessions"));
    expect(sessions.find((s) => s.id === "fake:worker")!.tag).toBe("cache");
  });

  it("summarises coordination for a directory", async () => {
    // A one-message session is low-signal, so the digest counts it without showing it.
    const digest = body<{ mode: string; cwd?: string; totalSessionCount: number }>(await call("coordination_digest", { cwd: projectDir }));
    expect(digest).toMatchObject({ mode: "coordination", cwd: projectDir, totalSessionCount: 1 });
    await expect(call("coordination_digest", { status: "sleeping" })).rejects.toThrow("invalid status");
  });

  it("posts to, reads and expands the feed of the default project", async () => {
    const post = body<{ id: string; lifecycle: { createdAt: string } }>(await call("post_to_feed", {
      type: "finding", title: "cache is per process", text: "The summary cache is an in-process Map.",
      paths: ["src/core/snapshot.ts"], as: "tester",
    }));
    expect(post.lifecycle.createdAt).toBe(NOW);

    const feed = body<{ items: { post: { id: string } }[] }>(await call("read_feed", { include_derived: false }));
    expect(feed.items.map((item) => item.post.id)).toContain(post.id);

    const expanded = body<{ id: string }>(await call("expand_post", { post_id: post.id, dir: projectDir }));
    expect(expanded.id).toBe(post.id);

    const missing = await call("expand_post", { post_id: "no-such-post" });
    expect(missing.isError).toBe(true);

    const rejected = await call("post_to_feed", { type: "finding", title: "no paths", text: "Findings need paths." });
    expect(rejected.isError).toBe(true);
  });

  it("says the usage index is missing rather than building it", async () => {
    const usage = body<{ index: { state: string }; report: unknown }>(await call("usage_report", { home: "/elsewhere" }));
    expect(usage.index.state).toBe("missing");
    expect(usage.report).toBeNull();
  });

  it("answers the skills and agents tools from the user's home", async () => {
    expect(body(await call("skills_report"))).toHaveProperty("index");
    expect(body(await call("skill_detail", { skill: "no-such-skill" }))).toMatchObject({ refused: { reason: "unknown_skill" } });
    expect(body(await call("archive_plan", { skill: "no-such-skill" }))).toMatchObject({ refused: { reason: "unknown_skill" } });
    expect(body(await call("list_agents", { all: true }))).toEqual(expect.any(Object));
  });
});
