import { describe, expect, it } from "vitest";
import {
  claudeCodeExtractor, codexExtractor, defaultExtractor, extractorFor, registerExtractor,
  whitelistedArgument,
} from "../src/usage/extract.js";
import type { ExtractContext } from "../src/usage/extract.js";
import type { RawMessage } from "../src/core/types.js";

const ctx: ExtractContext = {
  sourcePath: "/t/a.jsonl",
  adapter: "claude-code",
  agent: "claude",
  sessionId: "s1",
  cwd: "/repo",
  baseMsgIndex: 0,
};

function toolUseMessage(raw: Record<string, unknown>, toolCalls: RawMessage["toolCalls"]): RawMessage {
  return { role: "assistant", toolCalls, raw, timestamp: "2026-08-30T12:00:00.000Z" };
}

describe("whitelistedArgument", () => {
  it("extracts the skill argument from a Skill call", () => {
    expect(whitelistedArgument("Skill", { skill: "wayfinder" })).toBe("wayfinder");
  });

  it("extracts nothing from any other tool, however tempting the payload", () => {
    // ADR 0001: the index never stores the raw input blob, because it outlives the
    // transcript it came from.
    expect(whitelistedArgument("Bash", { command: "cat ~/.ssh/id_rsa" })).toBeNull();
    expect(whitelistedArgument("Read", { file_path: "/etc/passwd" })).toBeNull();
  });

  it("tolerates a missing or malformed input", () => {
    expect(whitelistedArgument("Skill", undefined)).toBeNull();
    expect(whitelistedArgument("Skill", "not an object")).toBeNull();
    expect(whitelistedArgument("Skill", { skill: 42 })).toBeNull();
  });
});

describe("claudeCodeExtractor", () => {
  it("extracts a Skill tool call with its whitelisted argument", () => {
    const rows = claudeCodeExtractor([toolUseMessage(
      { sessionId: "s1", cwd: "/repo", message: { content: [
        { type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "wayfinder" } },
      ] } },
      [{ name: "Skill", input: { skill: "wayfinder" }, status: "completed" }],
    )], ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceKind: "tool_call", tool: "Skill", skill: "wayfinder",
      callIndex: 0, msgIndex: 0, nativeCallId: "toolu_1", sidechain: false,
    });
  });

  it("indexes multiple tool calls in one message by call position", () => {
    const rows = claudeCodeExtractor([toolUseMessage(
      { message: { content: [
        { type: "tool_use", id: "a", name: "Bash", input: {} },
        { type: "tool_use", id: "b", name: "Read", input: {} },
      ] } },
      [{ name: "Bash" }, { name: "Read" }],
    )], ctx);
    expect(rows.map((r) => [r.callIndex, r.tool, r.nativeCallId]))
      .toEqual([[0, "Bash", "a"], [1, "Read", "b"]]);
  });

  it("extracts a slash command from a user message", () => {
    const rows = claudeCodeExtractor([{
      role: "user",
      raw: { type: "user", message: { content: "<command-name>/skill-creator</command-name>" } },
      timestamp: "2026-08-30T12:00:00.000Z",
    }], ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceKind: "slash_command", tool: "skill-creator", skill: "skill-creator", callIndex: 0,
    });
  });

  it("records slash-only skills a tool-call-only index would call never used", () => {
    // Skills carrying disable-model-invocation can *only* be slash-invoked.
    const rows = claudeCodeExtractor([{
      role: "user",
      raw: { type: "user", message: { content: "<command-name>/mattpocock-skills:wayfinder</command-name>" } },
      timestamp: "2026-08-30T12:00:00.000Z",
    }], ctx);
    expect(rows[0]?.skill).toBe("mattpocock-skills:wayfinder");
  });

  it("stores command names verbatim rather than normalising the plugin prefix", () => {
    // Two plugins can ship the same bare name, so stripping the prefix merges distinct
    // skills. Reconciliation is the inventory's job (ticket 04), not the index's.
    const bare = claudeCodeExtractor([{
      role: "user", raw: { type: "user", message: { content: "<command-name>/wayfinder</command-name>" } },
    }], ctx);
    const qualified = claudeCodeExtractor([{
      role: "user", raw: { type: "user", message: { content: "<command-name>/mattpocock-skills:wayfinder</command-name>" } },
    }], ctx);
    expect(bare[0]?.tool).toBe("wayfinder");
    expect(qualified[0]?.tool).toBe("mattpocock-skills:wayfinder");
  });

  it("stores built-in commands too rather than filtering at write time", () => {
    // /clear and /model are 117 of 239 command occurrences. Filtering to skills is a
    // query-time WHERE; dropping at write time is permanent under the 30-day rule.
    const rows = claudeCodeExtractor([{
      role: "user", raw: { type: "user", message: { content: "<command-name>/clear</command-name>" } },
    }], ctx);
    expect(rows[0]?.tool).toBe("clear");
  });

  it("counts one invocation however many times the tag appears in the record", () => {
    const rows = claudeCodeExtractor([{
      role: "user",
      raw: { type: "user", message: { content: "<command-name>/review</command-name> then <command-name>/review</command-name>" } },
    }], ctx);
    expect(rows).toHaveLength(1);
  });

  it("does not count an assistant message that merely quotes a command tag", () => {
    // Measured across the corpus: all 79 genuine invocations are type:"user" with
    // string content. The only record breaking that shape is an assistant discussing
    // the tag — counting it would let writing about a command inflate its usage.
    const rows = claudeCodeExtractor([{
      role: "assistant",
      raw: {
        type: "assistant",
        message: { content: [{ type: "text", text: "you can run <command-name>/skill-creator</command-name>" }] },
      },
    }], ctx);
    expect(rows).toHaveLength(0);
  });

  it("does not count a command tag echoed inside structured user content", () => {
    const rows = claudeCodeExtractor([{
      role: "user",
      raw: {
        type: "user",
        message: { content: [{ type: "text", text: "<command-name>/clear</command-name>" }] },
      },
    }], ctx);
    expect(rows).toHaveLength(0);
  });

  it("ignores a command-name-shaped string that is not in a message", () => {
    const rows = claudeCodeExtractor([{ role: "assistant", raw: {}, text: "<command-name>/nope</command-name>" }], ctx);
    expect(rows).toHaveLength(0);
  });

  it("flags a sidechain call and keeps its attribution agent", () => {
    const rows = claudeCodeExtractor([toolUseMessage(
      { isSidechain: true, attributionAgent: "general-purpose", message: { content: [
        { type: "tool_use", id: "x", name: "Skill", input: { skill: "mattpocock-skills:research" } },
      ] } },
      [{ name: "Skill", input: { skill: "mattpocock-skills:research" } }],
    )], ctx);
    expect(rows[0]).toMatchObject({
      sidechain: true, attributionAgent: "general-purpose", sourceKind: "tool_call",
    });
  });

  it("leaves attribution agent null for a main-loop call", () => {
    const rows = claudeCodeExtractor([toolUseMessage(
      { message: { content: [{ type: "tool_use", id: "x", name: "Skill", input: { skill: "s" } }] } },
      [{ name: "Skill", input: { skill: "s" } }],
    )], ctx);
    expect(rows[0]?.attributionAgent).toBeNull();
    expect(rows[0]?.sidechain).toBe(false);
  });

  it("offsets message indices by the resume point so a partial read keys correctly", () => {
    const rows = claudeCodeExtractor(
      [toolUseMessage({ message: { content: [] } }, [{ name: "Bash" }])],
      { ...ctx, baseMsgIndex: 40 },
    );
    expect(rows[0]?.msgIndex).toBe(40);
  });

  it("emits a tool call and a slash command from one message without colliding", () => {
    const rows = claudeCodeExtractor([{
      role: "user",
      raw: { type: "user", message: { content: "<command-name>/review</command-name>" } },
      toolCalls: [{ name: "Bash" }],
    }], ctx);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => `${r.msgIndex}:${r.callIndex}:${r.sourceKind}`)).size).toBe(2);
  });

  it("falls back to the epoch when a record carries no timestamp", () => {
    const rows = claudeCodeExtractor([{ role: "assistant", raw: {}, toolCalls: [{ name: "Bash" }] }], ctx);
    expect(rows[0]?.timestamp).toBe(new Date(0).toISOString());
  });
});

describe("extractor registry", () => {
  it("gives claude-code its own extractor", () => {
    expect(extractorFor("claude-code")).toBe(claudeCodeExtractor);
  });

  it("defaults an adapter with no extractor to tool calls only", () => {
    // gemini has no extractor of its own, so its slash invocations — if it has any —
    // are unattributable, which is why its `attributes` entry stays empty.
    expect(extractorFor("gemini")).toBe(defaultExtractor);
    const rows = defaultExtractor([{
      role: "user", raw: { type: "user", message: { content: "<command-name>/clear</command-name>" } },
      toolCalls: [{ name: "exec" }],
    }], { ...ctx, adapter: "gemini" });
    expect(rows.map((r) => r.tool)).toEqual(["exec"]);
  });

  it("accepts a registered extractor for a new adapter", () => {
    const custom = () => [];
    registerExtractor("made-up", custom);
    expect(extractorFor("made-up")).toBe(custom);
  });
});

describe("codexExtractor", () => {
  const codexCtx: ExtractContext = { ...ctx, adapter: "codex", agent: "codex" };

  /** The shape codex writes twice: once as an event, once as a response item. */
  function userTurn(text: string): RawMessage {
    return {
      role: "user",
      timestamp: "2026-08-30T12:00:00.000Z",
      raw: {
        type: "response_item",
        timestamp: "2026-08-30T12:00:00.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      },
    };
  }
  function eventCopy(text: string): RawMessage {
    // The adapter normalises event_msg to role "system"; this is the duplicate record.
    return {
      role: "system",
      raw: { type: "event_msg", payload: { type: "user_message", message: text } },
    };
  }

  it("extracts a slash invocation from a codex user turn", () => {
    const rows = codexExtractor([userTurn("<command-name>/humanizer-zh</command-name>")], codexCtx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceKind: "slash_command", tool: "humanizer-zh", skill: "humanizer-zh",
      callIndex: 0, adapter: "codex",
    });
  });

  it("counts one invocation despite codex writing every user turn twice", () => {
    // event_msg/user_message and response_item/message[role=user] are the SAME
    // invocation. Reading both shapes doubles every count.
    const text = "<command-name>/ce-code-review</command-name>";
    const rows = codexExtractor([eventCopy(text), userTurn(text)], codexCtx);
    expect(rows).toHaveLength(1);
  });

  it("ignores a command echoed in tool output", () => {
    const rows = codexExtractor([{
      role: "tool",
      raw: {
        type: "response_item",
        payload: { type: "custom_tool_call_output", output: "<command-name>/clear</command-name>" },
      },
    }], codexCtx);
    expect(rows).toHaveLength(0);
  });

  it("ignores an assistant message quoting a command", () => {
    const rows = codexExtractor([{
      role: "assistant",
      raw: {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "<command-name>/mcp</command-name>" }] },
      },
    }], codexCtx);
    expect(rows).toHaveLength(0);
  });

  it("counts one invocation per turn however many tags the turn carries", () => {
    const rows = codexExtractor([userTurn(
      "<command-name>/mcp</command-name> and <command-name>/mcp</command-name>",
    )], codexCtx);
    expect(rows).toHaveLength(1);
  });

  it("still records codex tool calls, which remain unattributable to a skill", () => {
    // A codex skill invocation is an `exec` like any other, so tool calls are indexed
    // but never carry a skill name. That is what makes codex partial, not attributed.
    const rows = codexExtractor([{
      role: "assistant",
      raw: { type: "response_item", payload: { type: "function_call" } },
      toolCalls: [{ name: "exec_command" }],
    }], codexCtx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceKind: "tool_call", tool: "exec_command", skill: null });
  });

  it("is the registered extractor for codex", () => {
    expect(extractorFor("codex")).toBe(codexExtractor);
  });
});
