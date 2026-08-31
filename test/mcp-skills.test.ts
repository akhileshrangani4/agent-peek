// test/mcp-skills.test.ts
//
// The MCP surface (ticket 08). Every test runs against a mkdtemp home: nothing here
// reads or writes a real skill root, and nothing builds an index outside the fixture.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/usage/store.js";
import type { Invocation, Watermark } from "../src/usage/schema.js";
import {
  usageTool, skillsTool, skillDetailTool, archivePlanTool, agentsTool,
  indexState, clampLimit, parseGroupBy, summarize, DEFAULT_LIMIT, MAX_LIMIT,
} from "../src/mcp/skills.js";
import type { SkillsReport } from "../src/skills/report.js";

const homes: string[] = [];
function fixtureHome(): string {
  const home = mkdtempSync(join(tmpdir(), "peek-mcp-"));
  homes.push(home);
  return home;
}
afterEach(() => {
  while (homes.length) rmSync(homes.pop()!, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string, description = "a fixture skill"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`, "utf8");
}

/** A home with a shared tree, two agent roots linking into it, and one local skill. */
function skillHome(): string {
  const home = fixtureHome();
  const shared = join(home, ".agents", "skills");
  writeSkill(join(shared, "shared-skill"), "shared-skill");
  for (const root of [join(home, ".claude", "skills"), join(home, ".codex", "skills")]) {
    mkdirSync(root, { recursive: true });
    symlinkSync(join(shared, "shared-skill"), join(root, "shared-skill"));
  }
  writeSkill(join(home, ".claude", "skills", "local-only"), "local-only");
  return home;
}

let seq = 0;
function inv(overrides: Partial<Invocation> = {}): Invocation {
  seq += 1;
  return {
    sourcePath: "/t/a.jsonl", msgIndex: seq, callIndex: 0, sourceKind: "tool_call",
    adapter: "claude-code", agent: "claude-code", sessionId: "s1",
    timestamp: "2026-08-30T12:00:00.000Z", tool: "Skill", skill: "local-only",
    cwd: "/repo", status: "completed", sidechain: false, attributionAgent: null,
    nativeCallId: null, ...overrides,
  };
}
function wm(overrides: Partial<Watermark> = {}): Watermark {
  return {
    sourcePath: "/t/a.jsonl", adapter: "claude-code", sessionId: "s1", cursor: null,
    msgIndex: 0, size: 1, mtimeMs: 1, scannedAt: "2026-08-30T12:00:00.000Z",
    deleted: false, ...overrides,
  };
}

function seedIndex(home: string, invocations: Invocation[]): void {
  const store = new UsageStore({ home });
  store.recordSource(invocations, wm());
  store.close();
}

describe("the index is never built from a tool call", () => {
  it("reports a missing index with a hint instead of scanning", async () => {
    const home = skillHome();
    const state = indexState(home);
    expect(state.state).toBe("missing");
    expect(state.hint).toMatch(/peek usage/);

    const result = await usageTool({ home });
    expect(result.report).toBeNull();
    expect(result.index.state).toBe("missing");
    // A first run scans every transcript and writes tens of megabytes. A tool call in
    // someone else's session must not trigger that silently.
    expect(existsSync(join(home, ".agent-peek", "usage.db"))).toBe(false);
  });

  it("withholds segments rather than reporting every skill as unused", async () => {
    const home = skillHome();
    const result = await skillsTool({ home });
    expect(result.segments).toBeNull();
    expect(result.totals.skills).toBeGreaterThan(0);
    expect(result.note).toMatch(/would read as unused/);
  });

  it("returns a skill's inventory facts but no usage when the index is missing", async () => {
    const home = skillHome();
    const result = await skillDetailTool({ home, skill: "local-only" });
    expect(result.skill.name).toBe("local-only");
    expect(result.installations).toBeNull();
  });
});

describe("usage_report", () => {
  it("returns the envelope, not a bare array", async () => {
    const home = skillHome();
    seedIndex(home, [inv(), inv(), inv({ skill: "shared-skill" })]);
    const { report } = await usageTool({ home });
    expect(report).not.toBeNull();
    // The caveats must be structurally impossible to drop.
    expect(report!).toHaveProperty("window");
    expect(report!).toHaveProperty("windows");
    expect(report!).toHaveProperty("blindSpots");
    expect(report!).toHaveProperty("partial");
    expect(report!).toHaveProperty("truncated");
    expect(report!.rows.length).toBeGreaterThan(0);
  });

  it("drops CLI built-ins by default and keeps them on request", async () => {
    const home = skillHome();
    seedIndex(home, [
      inv(),
      inv({ sourceKind: "slash_command", tool: "clear", skill: "clear" }),
    ]);
    const names = (r: Awaited<ReturnType<typeof usageTool>>) =>
      (r.report?.rows ?? []).map((row) => row.skill);
    expect(names(await usageTool({ home }))).not.toContain("clear");
    expect(names(await usageTool({ home, includeBuiltins: true }))).toContain("clear");
  });

  it("counts a slash-only invocation, which a tool-name filter would drop", async () => {
    const home = skillHome();
    seedIndex(home, [inv({ sourceKind: "slash_command", tool: "local-only", skill: "local-only" })]);
    const { report } = await usageTool({ home });
    expect(report!.rows.find((r) => r.skill === "local-only")?.count).toBe(1);
  });

  it("rejects an unknown grouping instead of silently defaulting", () => {
    expect(() => parseGroupBy("nonsense")).toThrowError(/Unknown groupBy dimension/);
    expect(parseGroupBy("skill,agent")).toEqual(["skill", "agent"]);
    expect(parseGroupBy(undefined)).toEqual(["skill"]);
  });
});

describe("result size", () => {
  it("caps the limit at both ends", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIMIT);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(10_000)).toBe(MAX_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit("many")).toBe(DEFAULT_LIMIT);
  });

  it("summarises every segment but returns rows only up to the limit", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      key: `k${i}`, name: `s${i}`, tokens: 50 - i, agents: ["claude-code"], uses: 0,
      usesLabel: "0", reason: "no recorded use",
    }));
    const report = {
      segments: [
        { id: "archivable" as const, title: "T", note: "N", rows, tokens: 100 },
        { id: "in-use" as const, title: "T", note: "N", rows: rows.slice(0, 3), tokens: 10 },
      ],
      unmatched: Array.from({ length: 40 }, (_, i) => ({ name: `u${i}`, uses: i })),
      costBasis: "basis", totalSkills: 53, totalTokens: 110,
    } as unknown as SkillsReport;

    const out = summarize(report, 5);
    expect(out.segments[0]!.rows).toHaveLength(5);
    // The totals still describe the whole set, so a capped slice cannot read as complete.
    expect(out.segments[0]!.skills).toBe(50);
    expect(out.segments[0]!.truncated).toBe(true);
    expect(out.segments[1]!.truncated).toBe(false);
    expect(out.totals.bySegment).toMatchObject({ archivable: 50, "in-use": 3 });
    expect(out.unmatched).toHaveLength(5);
    expect(out.unmatchedTotal).toBe(40);
  });

  it("returns one segment's rows when asked, with totals for all", () => {
    const report = {
      segments: [
        { id: "archivable" as const, title: "T", note: "N", rows: [{ name: "a" }], tokens: 1 },
        { id: "unknown-usage" as const, title: "T", note: "N", rows: [{ name: "b" }], tokens: 2 },
      ],
      unmatched: [], costBasis: "b", totalSkills: 2, totalTokens: 3,
    } as unknown as SkillsReport;
    const out = summarize(report, 10, "unknown-usage");
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]!.id).toBe("unknown-usage");
    expect(Object.keys(out.totals.bySegment)).toEqual(["archivable", "unknown-usage"]);
  });
});

describe("skills_report with an index", () => {
  it("segments and carries the cost basis", async () => {
    const home = skillHome();
    seedIndex(home, [inv()]);
    const result = await skillsTool({ home });
    expect(result.segments).not.toBeNull();
    expect(result.costBasis).toMatch(/upper bound/i);
    expect(result.totals.skills).toBeGreaterThan(0);
  });

  it("never flattens an unattributable count to zero", async () => {
    const home = skillHome();
    seedIndex(home, [inv()]);
    const result = await skillsTool({ home });
    const labels = (result.segments ?? []).flatMap((s) => s.rows.map((r) => r.usesLabel));
    for (const label of labels) expect(label).not.toBe("");
    // A codex installation cannot be attributed, so its row must not claim zero uses.
    const unknown = (result.segments ?? []).find((s) => s.id === "unknown-usage");
    if (unknown && unknown.rows.length) {
      expect(unknown.rows.some((r) => r.usesLabel === "unknown")).toBe(true);
    }
  });
});

describe("archive_plan", () => {
  it("returns the plan and the command, and changes nothing", async () => {
    const home = skillHome();
    const before = existsSync(join(home, ".claude", "skills", "local-only", "SKILL.md"));
    const result = await archivePlanTool({ home, skill: "local-only" });
    expect(result.plan?.actions[0]!.kind).toBe("move");
    expect(result.command).toContain("peek skills archive local-only --yes");
    expect(result.note).toMatch(/did not change anything/);
    expect(existsSync(join(home, ".claude", "skills", "local-only", "SKILL.md"))).toBe(before);
  });

  it("surfaces a refusal as data rather than throwing", async () => {
    const home = skillHome();
    const result = await archivePlanTool({ home, skill: "shared-skill" });
    // Installed for two agents: peek refuses to guess the scope (ticket 05).
    expect(result.refused?.reason).toBe("scope_required");
    expect(result.refused?.detail.length).toBe(2);
  });

  it("plans an unlink for one agent, leaving the shared content alone", async () => {
    const home = skillHome();
    const result = await archivePlanTool({ home, skill: "shared-skill", agent: "codex" });
    expect(result.plan?.actions).toHaveLength(1);
    expect(result.plan?.actions[0]!.kind).toBe("unlink");
    expect(result.plan?.skipped.some((s) => s.reason.includes("shared tree"))).toBe(true);
  });
});

describe("list_agents", () => {
  it("reports presence, tier, and what peek can observe", async () => {
    const home = skillHome();
    const result = await agentsTool({ home });
    expect(result.totals.known).toBeGreaterThan(50);
    const claude = result.agents.find((a) => a.slug === "claude-code");
    expect(claude?.tier).toBe("verified");
    expect(claude?.observes).toContain("slash_command");
  });

  it("hides agents that are not installed here unless asked", async () => {
    const home = skillHome();
    const some = await agentsTool({ home });
    const all = await agentsTool({ home, all: true });
    expect(all.agents.length).toBeGreaterThan(some.agents.length);
  });
});
