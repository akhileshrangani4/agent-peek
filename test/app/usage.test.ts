// test/app/usage.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageService, indexState, parseGroupByList } from "../../src/app/usage.js";
import type { Invocation, Watermark } from "../../src/usage/schema.js";
import { UsageStore, usageDbPath } from "../../src/usage/store.js";
import { makeTmpHome } from "../helpers/tmp-home.js";
import { fakeAdapter } from "./fixtures.js";

let seq = 0;
function inv(overrides: Partial<Invocation>): Invocation {
  seq += 1;
  return {
    sourcePath: "/t/a.jsonl", msgIndex: seq, callIndex: 0, sourceKind: "tool_call",
    adapter: "claude-code", agent: "claude-code", sessionId: "s1",
    timestamp: "2026-11-01T12:00:00.000Z", tool: "Skill", skill: null,
    cwd: "/repo", status: "completed", sidechain: false, attributionAgent: null,
    nativeCallId: null, ...overrides,
  };
}

const watermark: Watermark = {
  sourcePath: "/t/a.jsonl", adapter: "claude-code", sessionId: "s1", cursor: null,
  msgIndex: 0, size: 1, mtimeMs: 1, scannedAt: "2026-11-01T12:00:00.000Z", deleted: false,
};

describe("usage argument rules", () => {
  it("accepts only declared grouping dimensions", () => {
    expect(parseGroupByList("skill, day")).toEqual({ ok: true, dims: ["skill", "day"] });
    expect(parseGroupByList("skill,colour,size")).toEqual({ ok: false, invalid: ["colour", "size"] });
    expect(parseGroupByList("")).toEqual({ ok: true, dims: [] });
  });
});

describe("UsageService", () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let store: UsageStore | undefined;

  beforeEach(async () => { ({ home, cleanup } = await makeTmpHome()); });
  afterEach(async () => {
    store?.close();
    store = undefined;
    await cleanup();
  });

  function open(): UsageService {
    store = new UsageStore({ home });
    return new UsageService({ store, home });
  }

  it("says the index is missing until someone builds it, and never creates it", () => {
    const missing = indexState(home);
    expect(missing).toMatchObject({ state: "missing", path: usageDbPath(home) });
    expect(missing.hint).toMatch(/Run `peek usage` once in a terminal/);
    expect(indexState(home).state).toBe("missing");
    open();
    expect(indexState(home)).toEqual({ state: "ready", path: usageDbPath(home) });
  });

  it("drops CLI built-ins from a skills report before the limit is applied", async () => {
    const usage = open();
    store!.recordSource([
      inv({ tool: "clear", skill: "clear", sourceKind: "slash_command" }),
      inv({ tool: "clear", skill: "clear", sourceKind: "slash_command" }),
      inv({ tool: "clear", skill: "clear", sourceKind: "slash_command" }),
      inv({ tool: "Skill", skill: "wayfinder" }),
    ], watermark);

    const report = await usage.report({ filter: { skillsOnly: true }, groupBy: ["skill"], limit: 1 });
    expect(report.rows.map((row) => row.skill)).toEqual(["wayfinder"]);
    expect(report.truncated).toBe(false);

    const withBuiltins = await usage.report({ filter: { skillsOnly: true }, groupBy: ["skill"], limit: 5, includeBuiltins: true });
    expect(withBuiltins.rows.map((row) => row.skill)).toEqual(["clear", "wayfinder"]);
  });

  it("keeps every row when the report is not about skills", async () => {
    const usage = open();
    store!.recordSource([inv({ tool: "Bash" }), inv({ tool: "clear", skill: "clear", sourceKind: "slash_command" })], watermark);
    const report = await usage.report({ filter: {}, groupBy: ["tool"], limit: 10 });
    expect(report.rows.map((row) => row.tool).sort()).toEqual(["Bash", "clear"]);
  });

  it("scans adapters into the index and reports a first run", async () => {
    const usage = open();
    expect(usage.isEmpty()).toBe(true);
    const result = await usage.scan([fakeAdapter([])]);
    expect(result).toMatchObject({ bootstrap: true, invocations: 0, errors: [] });
  });
});
