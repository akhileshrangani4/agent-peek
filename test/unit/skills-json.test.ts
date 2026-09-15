import { describe, it, expect } from "vitest";
import { compactSkillsJson } from "../../src/cli/skills-json.js";

describe("compactSkillsJson", () => {
  it("keeps one small record per skill and the segment totals, drops installations and roots", () => {
    const full = {
      costBasis: "x",
      projects: { surveyed: ["/a"], found: 1, skills: 2, tokens: 30 },
      rootsScanned: [{ path: "/r1", kind: "agent", present: true }, { path: "/r2", kind: "library", present: false }],
      segments: [{ id: "archivable", title: "t", note: "n", count: 1, tokens: 10 }],
      unmatched: [{ name: "loop", uses: 6, why: "ships-with-agent" }],
      skills: [{
        key: "/k", name: "s", chargedTokens: 10, modelInvocable: true, segment: "archivable", reason: "no recorded use",
        installations: [{ agent: "claude-code", path: "/p1", rootPath: "/r1" }, { agent: "codex", path: "/p2", rootPath: "/r1" }, { path: "/p3", rootPath: "/r2" }],
        flags: [{ kind: "duplicate-name", evidence: "...".repeat(100) }],
      }],
    };
    const out = compactSkillsJson(full) as Record<string, unknown>;
    expect(out.skills).toEqual([{
      key: "/k", name: "s", segment: "archivable", reason: "no recorded use", tokens: 10,
      agents: ["claude-code", "codex"], installations: 3, modelInvocable: true, flags: ["duplicate-name"],
    }]);
    expect(out.rootsScanned).toBe(2);
    expect(out.segments).toEqual(full.segments);
    expect(out.unmatched).toEqual(full.unmatched);
    expect(out.projects).toEqual(full.projects);
    expect(JSON.stringify(out)).not.toContain("/p1");
    expect(String(out.details)).toMatch(/--details/);
  });
});
