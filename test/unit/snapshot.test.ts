import { describe, it, expect } from "vitest";
import { toRaw, toStructured } from "../../src/core/snapshot.js";
import type { RawMessage } from "../../src/core/types.js";

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
