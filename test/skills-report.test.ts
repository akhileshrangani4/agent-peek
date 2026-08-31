import { describe, expect, it } from "vitest";
import { buildSkillsReport, expandSkill, selectableForArchive } from "../src/skills/report.js";
import type { ReportInput } from "../src/skills/report.js";
import type { Skill, SkillInstallation } from "../src/skills/types.js";
import type { InstallationCoverage } from "../src/usage/coverage.js";

function cov(agent: string, state: InstallationCoverage["state"]): InstallationCoverage {
  return {
    agent, state,
    attributes: state === "attributed" ? ["tool_call", "slash_command"] : [],
    blind: state === "attributed" ? [] : ["tool_call", "slash_command"],
  };
}

function install(overrides: Partial<SkillInstallation> = {}): SkillInstallation {
  return {
    agent: "claude-code", rootPath: "/r", rootKind: "user", mutable: true,
    path: "/r/s", symlink: false, chargedTokens: 100, ...overrides,
  };
}

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    key: "k1", name: "s1", modelInvocable: true, estimatedTokens: 100,
    chargedTokens: 100, installations: [install()], flags: [], ...overrides,
  };
}

function input(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    skills: [skill()],
    usage: new Map(),
    ambiguousKeys: new Set(),
    coverage: new Map([["claude-code", cov("claude-code", "attributed")]]),
    unmatched: [],
    costBasis: "test",
    ...overrides,
  };
}

function segment(report: ReturnType<typeof buildSkillsReport>, id: string) {
  return report.segments.find((s) => s.id === id)!;
}

describe("buildSkillsReport segmentation", () => {
  it("offers an unused, fully attributable, mutable skill", () => {
    const report = buildSkillsReport(input());
    expect(segment(report, "archivable").rows.map((r) => r.name)).toEqual(["s1"]);
    expect(segment(report, "archivable").rows[0]?.usesLabel).toBe("0");
  });

  it("never offers a skill with recorded usage", () => {
    const report = buildSkillsReport(input({
      usage: new Map([["k1", new Map([["claude-code", 3]])]]),
    }));
    expect(segment(report, "archivable").rows).toEqual([]);
    expect(segment(report, "in-use").rows[0]?.usesLabel).toBe("3");
  });

  it("never offers a skill whose invoked name is ambiguous", () => {
    // The count is real but belongs to neither of the skills answering to the name, so
    // a low number is not evidence about this one.
    const report = buildSkillsReport(input({ ambiguousKeys: new Set(["k1"]) }));
    expect(segment(report, "archivable").rows).toEqual([]);
    expect(segment(report, "unknown-usage").rows[0]?.usesLabel).toBe("ambiguous");
    expect(segment(report, "unknown-usage").rows[0]?.uses).toBeNull();
  });

  it("never offers a read-only installation", () => {
    // Being unable to act on a row is not the same as it being safe to act on. The
    // prototype offered plugin skills for archiving and proposed moving their paths.
    const report = buildSkillsReport(input({
      skills: [skill({ installations: [install({ mutable: false, rootKind: "plugin" })] })],
    }));
    expect(segment(report, "archivable").rows).toEqual([]);
    expect(segment(report, "read-only").rows[0]?.name).toBe("s1");
  });

  it("never offers a skill installed on an agent whose usage is unattributable", () => {
    const report = buildSkillsReport(input({
      skills: [skill({ installations: [install(), install({ agent: "cursor" })] })],
      coverage: new Map([
        ["claude-code", cov("claude-code", "attributed")],
        ["cursor", cov("cursor", "unreadable")],
      ]),
    }));
    expect(segment(report, "archivable").rows).toEqual([]);
    expect(segment(report, "unknown-usage").rows[0]?.reason).toContain("cursor");
  });

  it("reads a zero as unknown unless EVERY installation is attributable", () => {
    // Zero observed where peek can see, plus unknown where it cannot, sums to unknown.
    // Requiring only "some attributable" reproduced the false zero in a subtler place.
    const report = buildSkillsReport(input({
      skills: [skill({ installations: [install(), install({ agent: "goose" })] })],
      coverage: new Map([
        ["claude-code", cov("claude-code", "attributed")],
        ["goose", cov("goose", "opaque")],
      ]),
    }));
    expect(segment(report, "unknown-usage").rows[0]?.usesLabel).toBe("unknown");
  });

  it("never caveats a non-zero count, whatever the coverage", () => {
    const report = buildSkillsReport(input({
      skills: [skill({ installations: [install({ agent: "cursor" })] })],
      usage: new Map([["k1", new Map([["cursor", 7]])]]),
      coverage: new Map([["cursor", cov("cursor", "unreadable")]]),
    }));
    expect(segment(report, "in-use").rows[0]?.usesLabel).toBe("7");
  });

  it("treats a shared-library-only skill as read-only, not archivable", () => {
    // No agent's system prompt reads the shared root, so it is not installed for anyone.
    const report = buildSkillsReport(input({
      skills: [skill({ installations: [install({ agent: undefined })] })],
    }));
    expect(segment(report, "archivable").rows).toEqual([]);
    expect(segment(report, "read-only").rows[0]?.reason).toContain("shared library");
  });

  it("sorts the archivable segment by token cost", () => {
    // Rows here have no recorded use by definition, so there is no last-seen to sort
    // by; cost is the lever, since context reduction is the point.
    const report = buildSkillsReport(input({
      skills: [
        skill({ key: "a", name: "small", chargedTokens: 10, installations: [install({ chargedTokens: 10 })] }),
        skill({ key: "b", name: "big", chargedTokens: 900, installations: [install({ chargedTokens: 900 })] }),
      ],
    }));
    expect(segment(report, "archivable").rows.map((r) => r.name)).toEqual(["big", "small"]);
  });

  it("reports unmatched invocation names beside the segments, never inside them", () => {
    const report = buildSkillsReport(input({
      unmatched: [{ name: "gone", uses: 2, reason: "not-on-disk" as const, note: "" }, { name: "pre-pr-duplication", uses: 9, reason: "not-on-disk" as const, note: "" }],
    }));
    expect(report.unmatched.map((u) => u.name)).toEqual(["pre-pr-duplication", "gone"]);
    for (const seg of report.segments) {
      expect(seg.rows.map((r) => r.name)).not.toContain("pre-pr-duplication");
    }
  });
});

describe("selectableForArchive", () => {
  it("returns only the archivable segment", () => {
    const report = buildSkillsReport(input({
      skills: [
        skill(),
        skill({ key: "k2", name: "used" }),
        skill({ key: "k3", name: "plugin", installations: [install({ mutable: false })] }),
      ],
      usage: new Map([["k2", new Map([["claude-code", 1]])]]),
    }));
    expect(selectableForArchive(report).map((r) => r.name)).toEqual(["s1"]);
  });

  it("is empty when nothing can be offered honestly", () => {
    const report = buildSkillsReport(input({
      skills: [skill({ installations: [install({ agent: "cursor" })] })],
      coverage: new Map([["cursor", cov("cursor", "unreadable")]]),
    }));
    expect(selectableForArchive(report)).toEqual([]);
  });
});

describe("expandSkill", () => {
  it("shows one row per installation, so unlink and retire stay distinct", () => {
    const s = skill({
      installations: [
        install({ agent: "claude-code", symlink: true, path: "/a" }),
        install({ agent: "codex", symlink: true, path: "/b" }),
      ],
    });
    const rows = expandSkill(input({
      skills: [s],
      coverage: new Map([
        ["claude-code", cov("claude-code", "attributed")],
        ["codex", cov("codex", "opaque")],
      ]),
    }), s);
    expect(rows.map((r) => r.agent)).toEqual(["claude-code", "codex"]);
    expect(rows.map((r) => r.action)).toEqual(["unlink", "unlink"]);
    expect(rows.map((r) => r.usesLabel)).toEqual(["0", "unknown"]);
  });

  it("marks a real directory as a move and a read-only root as a refusal", () => {
    const s = skill({
      installations: [
        install({ agent: "claude-code", symlink: false }),
        install({ agent: "codex", mutable: false }),
      ],
    });
    const rows = expandSkill(input({ skills: [s] }), s);
    expect(rows.map((r) => r.action)).toEqual(["move", "refuse"]);
  });
});

describe("an agent peek cannot confirm does not withhold a verdict", () => {
  const skill = (): Skill => ({
    key: "k", name: "n", description: "d", modelInvocable: true, estimatedTokens: 10,
    chargedTokens: 10, flags: [],
    installations: [
      { agent: "claude-code", rootPath: "/c", rootKind: "user", mutable: true, path: "/c/n", symlink: false, chargedTokens: 10 },
      { agent: "roo", rootPath: "/r", rootKind: "user", mutable: true, path: "/r/n", symlink: true, chargedTokens: 0 },
    ],
  });

  it("never offers a skill whose only mutable installations are unconfirmed", () => {
    // Discounting an unconfirmed agent's unobservability is right; offering a destructive
    // action against one is not. Unlinking from a directory the installer made for a
    // product that may not exist shrinks no confirmed agent's context.
    const onlyUnconfirmed: Skill = {
      key: "u", name: "u", description: "d", modelInvocable: true, estimatedTokens: 5,
      chargedTokens: 5, flags: [],
      installations: [
        { agent: "roo", rootPath: "/r", rootKind: "user", mutable: true, path: "/r/u", symlink: true, chargedTokens: 5 },
        { agent: "zed", rootPath: "/s", rootKind: "shared", mutable: false, path: "/s/u", symlink: false, chargedTokens: 0 },
      ],
    };
    const report = buildSkillsReport(input({
      skills: [onlyUnconfirmed], unconfirmedAgents: new Set(["roo"]),
    }));
    expect(report.segments.find((s) => s.id === "archivable")!.rows).toHaveLength(0);
    const readOnly = report.segments.find((s) => s.id === "read-only")!.rows[0]!;
    expect(readOnly.reason).toMatch(/cannot confirm are installed/);
  });

  it("holds two invariants over every archivable row", () => {
    const report = buildSkillsReport(input({
      skills: [skill()],
      coverage: new Map([["claude-code", { agent: "claude-code", state: "attributed", attributes: ["tool_call"], blind: [] }]]),
      unconfirmedAgents: new Set(["roo"]),
    }));
    for (const row of report.segments.find((s) => s.id === "archivable")!.rows) {
      // The segment promises attributable usage: a row reading `unknown` there is the
      // false-zero problem inverted.
      expect(row.usesLabel).toBe("0");
      // And something must actually be actionable.
      expect(row.agents.length).toBeGreaterThan(0);
    }
  });

  it("archives when the only unattributable installation is an unconfirmed agent", () => {
    const report = buildSkillsReport(input({
      skills: [skill()],
      coverage: new Map([["claude-code", { agent: "claude-code", state: "attributed", attributes: ["tool_call"], blind: [] }]]),
      unconfirmedAgents: new Set(["roo"]),
    }));
    const row = report.segments.find((s) => s.id === "archivable")!.rows[0]!;
    expect(row).toBeDefined();
    // The discount is disclosed, not silent: the user can tell why this row is here.
    expect(row.reason).toMatch(/cannot confirm are installed/);
  });

  it("still withholds when a confirmed agent cannot be attributed", () => {
    const report = buildSkillsReport(input({
      skills: [skill()],
      coverage: new Map([["claude-code", { agent: "claude-code", state: "attributed", attributes: ["tool_call"], blind: [] }]]),
      unconfirmedAgents: new Set(),
    }));
    expect(report.segments.find((s) => s.id === "unknown-usage")!.rows).toHaveLength(1);
  });

  it("labels the unconfirmed installation at the confirm step", () => {
    // Dry-run plus a line naming "unlink from roo" is the only thing standing between the
    // relaxed verdict and a wrong deletion, if the agent is in fact installed.
    const rows = expandSkill(input({ skills: [skill()], unconfirmedAgents: new Set(["roo"]) }), skill());
    expect(rows.find((r) => r.agent === "roo")!.unconfirmedAgent).toBe(true);
    expect(rows.find((r) => r.agent === "claude-code")!.unconfirmedAgent).toBeUndefined();
  });
});
