import { describe, expect, it } from "vitest";
import {
  claudeCodeExtractor, defaultExtractor, extractorFor, registerExtractor, whitelistedArgument,
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

  it("defaults every other adapter to tool calls only", () => {
    // Codex has no Skill tool at all; its extractor is a separate future function.
    expect(extractorFor("codex")).toBe(defaultExtractor);
    const rows = defaultExtractor([{
      role: "user", raw: { type: "user", message: { content: "<command-name>/clear</command-name>" } },
      toolCalls: [{ name: "exec" }],
    }], { ...ctx, adapter: "codex" });
    expect(rows.map((r) => r.tool)).toEqual(["exec"]);
  });

  it("accepts a registered extractor for a new adapter", () => {
    const custom = () => [];
    registerExtractor("made-up", custom);
    expect(extractorFor("made-up")).toBe(custom);
  });
});
