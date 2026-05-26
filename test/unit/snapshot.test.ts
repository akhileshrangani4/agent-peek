import { describe, it, expect } from "vitest";
import { toBrief, toHandoff, toRaw, toStructured, toSummary } from "../../src/core/snapshot.js";
import type { RawMessage } from "../../src/core/types.js";
import { withEnv } from "../helpers/tmp-home.js";

const msgs = (): RawMessage[] => [
  { role: "user", text: "do X", raw: {} },
  { role: "assistant", text: "starting", raw: {} },
  { role: "assistant", text: undefined, toolCalls: [{ name: "Read", input: { p: "f" }, status: "pending" }], raw: {} },
  { role: "tool", text: undefined, toolCalls: [{ name: "(result)", output: "contents", status: "completed" }], raw: {} },
  { role: "assistant", text: "done", raw: {} },
];

describe("snapshot.toRaw", () => {
  it("passes through messages", () => {
    const s = toRaw("sid", msgs());
    expect(s.mode).toBe("raw");
    expect(s.sessionId).toBe("sid");
    expect(s.messages.length).toBe(5);
  });

  it("respects limit", () => {
    const s = toRaw("sid", msgs(), { limit: 2 });
    expect(s.messages.length).toBe(2);
    // tail of 2 = last 2 messages
    expect(s.messages[1]!.text).toBe("done");
    expect(s.window).toEqual({ start: 3, end: 5, order: "oldest-first" });
  });

  it("supports first, offset, around, and newest-first windows", () => {
    expect(toRaw("sid", msgs(), { limit: 2, from: "start" }).messages.map((m) => m.text)).toEqual(["do X", "starting"]);
    expect(toRaw("sid", msgs(), { limit: 2, offset: 1 }).messages.map((m) => m.text)).toEqual([undefined, undefined]);
    expect(toRaw("sid", msgs(), { limit: 3, around: 2 }).window).toEqual({ start: 0, end: 3, order: "oldest-first" });
    expect(toRaw("sid", msgs(), { limit: 2, order: "newest-first" }).messages.map((m) => m.text)).toEqual(["done", undefined]);
  });
});

describe("snapshot.toStructured", () => {
  it("derives lastUser/lastAssistant + counts", () => {
    const s = toStructured("sid", msgs());
    expect(s.mode).toBe("structured");
    expect(s.messageCount).toBe(5);
    expect(s.lastUserMessage).toBe("do X");
    expect(s.lastAssistantMessage).toBe("done");
  });

  it("includes touched and writing file context", () => {
    const s = toStructured("sid", [
      { role: "user", text: "edit", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Edit", input: { path: "src/a.ts" }, status: "pending" }], raw: {} },
    ], "/repo");
    expect(s.touchedFiles).toEqual(["/repo/src/a.ts"]);
    expect(s.writingFiles).toEqual(["/repo/src/a.ts"]);
  });

  it("excludes tool result placeholders from recent tools", () => {
    const s = toStructured("sid", msgs());
    expect(s.lastToolCalls.map((tool) => tool.name)).toEqual(["Read"]);
  });

  it("activity tool-running while a tool_use is unanswered", () => {
    const m: RawMessage[] = [
      { role: "user", text: "x", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", status: "pending" }], raw: {} },
    ];
    const s = toStructured("sid", m);
    expect(s.activity).toBe("tool-running");
    expect(s.pendingToolCalls.length).toBe(1);
  });

  it("activity thinking when last is assistant text", () => {
    const m: RawMessage[] = [
      { role: "user", text: "x", raw: {} },
      { role: "assistant", text: "considering", raw: {} },
    ];
    expect(toStructured("s", m).activity).toBe("thinking");
  });

  it("activity idle when last is user", () => {
    const m: RawMessage[] = [{ role: "user", text: "x", raw: {} }];
    expect(toStructured("s", m).activity).toBe("idle");
  });

  it("currentTask comes from last user message (heuristic)", () => {
    const s = toStructured("sid", msgs());
    expect(s.currentTask).toBe("do X");
  });
});

describe("snapshot.toBrief", () => {
  it("creates a local non-LLM summary", () => {
    const s = toBrief("sid", msgs());
    expect(s.mode).toBe("brief");
    expect(s.brief).toMatch(/Task: do X/);
    expect(s.brief).toMatch(/Last assistant: done/);
    expect(s.recentTools).toContain("Read");
  });
});

describe("snapshot.toHandoff", () => {
  it("extracts local handoff fields", () => {
    const s = toHandoff("sid", [
      { role: "system", text: "AskUserQuestion/Question: present choices?", raw: {} },
      { role: "user", text: "Can you add resources?", raw: {} },
      { role: "assistant", text: "Implemented MCP resources. Next I will add prompts.", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Read", input: { path: "src/mcp/index.ts" }, status: "pending" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "exec_command", input: { cmd: "cat \"src/core/engine.ts\"" }, status: "pending" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "exec_command", input: { cmd: "curl https://example.com/foo/bar && echo Content-Type: application/json" }, status: "pending" }], raw: {} },
    ], "/work/repo");
    expect(s.mode).toBe("handoff");
    expect(s.decisions).toContain("Implemented MCP resources.");
    expect(s.nextActions).toContain("Next I will add prompts.");
    expect(s.openQuestions).toContain("Can you add resources?");
    expect(s.openQuestions).not.toContain("AskUserQuestion/Question: present choices?");
    expect(s.touchedFiles).toEqual(["/work/repo/src/core/engine.ts", "/work/repo/src/mcp/index.ts"]);
    expect(s.recentTools).toContain("Read");
  });
});

describe("snapshot.toSummary", () => {
  it("creates a no-dependency local summary when no API key is configured", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "", AGENT_PEEK_SUMMARY_PROVIDER: "" }, async () => {
      const s = await toSummary("sid", [{ role: "user", text: "hi", raw: {} }], { deltaMessageCount: 1 });
      expect(s.mode).toBe("summary");
      expect(s.fallback).toBeFalsy();
      expect(s.structured).toBeUndefined();
      expect(s.summary).toMatch(/Current task: hi/);
    });
  });

  it("can force the local summary provider even when an Anthropic key is present", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "test-key", AGENT_PEEK_SUMMARY_PROVIDER: "local" }, async () => {
      const s = await toSummary("sid", msgs(), { deltaMessageCount: 5 });
      expect(s.summary).toMatch(/Current task: do X/);
      expect(s.summary).toMatch(/Recent tools: Read/);
    });
  });

  it("calls anthropic client when key present", async () => {
    let captured: any = null;
    const mockClient = {
      messages: {
        create: async (req: any) => {
          captured = req;
          return { content: [{ type: "text", text: "Agent is doing X." }] };
        },
      },
    };
    const s = await toSummary(
      "sid",
      [{ role: "user", text: "do X", raw: {} }],
      { deltaMessageCount: 1, client: mockClient as any, model: "claude-haiku-4-5" },
    );
    expect(s.summary).toBe("Agent is doing X.");
    expect(s.fallback).toBeFalsy();
    expect(captured.model).toBe("claude-haiku-4-5");
  });

  it("caches by (sessionId, cursor) for 60s", async () => {
    let calls = 0;
    const mockClient = {
      messages: {
        create: async () => { calls++; return { content: [{ type: "text", text: "x" }] }; },
      },
    };
    const m = [{ role: "user" as const, text: "a", raw: {} }];
    await toSummary("sid", m, { deltaMessageCount: 1, client: mockClient as any, cacheKey: "k1" });
    await toSummary("sid", m, { deltaMessageCount: 1, client: mockClient as any, cacheKey: "k1" });
    expect(calls).toBe(1);
  });
});
