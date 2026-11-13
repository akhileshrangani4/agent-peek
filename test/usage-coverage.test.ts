import { describe, expect, it } from "vitest";
import {
  coverageFor, zeroMeansUnused, renderCount, eligibleForBulkUnused, explainCoverage,
} from "../src/usage/coverage.js";
import type { ResolvedAgent } from "../src/agents/index.js";

function agent(overrides: Partial<ResolvedAgent> = {}): ResolvedAgent {
  return {
    slug: "claude-code", displayName: "Claude Code", adapter: "claude-code", roots: [],
    observes: ["tool_call", "slash_command"], observable: true,
    attributes: ["tool_call", "slash_command"], attributable: true,
    manageable: true, ...overrides,
  } as ResolvedAgent;
}

describe("coverageFor", () => {
  it("calls an agent attributed when every invocation kind names a skill", () => {
    expect(coverageFor(agent()).state).toBe("attributed");
    expect(coverageFor(agent()).blind).toEqual([]);
  });

  it("calls an agent partial when it attributes one kind and not the other", () => {
    // Codex is the case that forces this state to exist: it records slash commands but
    // a skill invocation on its tool-call path is an `exec` like any other.
    const c = coverageFor(agent({
      slug: "codex", adapter: "codex",
      observes: ["tool_call"], attributes: ["slash_command"], attributable: true,
    }));
    expect(c.state).toBe("partial");
    expect(c.blind).toEqual(["tool_call"]);
  });

  it("calls an agent opaque when it has an adapter that attributes nothing", () => {
    // Readable transcripts, but nothing in them names a skill. Distinct from having no
    // adapter at all, because the fix is different: an extractor, not an adapter.
    const c = coverageFor(agent({
      slug: "codex", adapter: "codex", observes: ["tool_call"],
      attributes: [], attributable: false,
    }));
    expect(c.state).toBe("opaque");
  });

  it("calls an agent unreadable when it has no adapter", () => {
    const c = coverageFor(agent({
      slug: "cursor", adapter: undefined, observes: [], observable: false,
      attributes: [], attributable: false,
    }));
    expect(c.state).toBe("unreadable");
  });

  it("treats observing a kind as weaker than attributing it", () => {
    // The distinction the whole ticket turns on: 8,237 codex invocations were observed
    // and zero could be attributed to a skill.
    const c = coverageFor(agent({
      slug: "codex", adapter: "codex", observes: ["tool_call"], observable: true,
      attributes: [], attributable: false,
    }));
    expect(c.state).not.toBe("attributed");
    expect(zeroMeansUnused(c)).toBe(false);
  });
});

describe("renderCount", () => {
  const attributed = coverageFor(agent());
  const unreadable = coverageFor(agent({
    slug: "cursor", adapter: undefined, observes: [], observable: false,
    attributes: [], attributable: false,
  }));

  it("renders an unattributable zero as unknown, never as 0", () => {
    // "never used" and "cannot see usage" rendering identically is the failure this
    // ticket exists to prevent.
    expect(renderCount(0, unreadable)).toBe("unknown");
  });

  it("renders an attributable zero as 0", () => {
    expect(renderCount(0, attributed)).toBe("0");
  });

  it("never caveats a non-zero count, whatever the agent", () => {
    // A skill with 12 recorded invocations is demonstrably used; coverage cannot make
    // that ambiguous, and marking it would put a caveat on 78% of rows for nothing.
    expect(renderCount(12, unreadable)).toBe("12");
    expect(renderCount(12, attributed)).toBe("12");
  });

  it("treats a partial agent's zero as unknown too", () => {
    const partial = coverageFor(agent({
      slug: "codex", adapter: "codex", observes: ["tool_call"],
      attributes: ["slash_command"], attributable: true,
    }));
    expect(renderCount(0, partial)).toBe("unknown");
  });
});

describe("eligibleForBulkUnused", () => {
  const attributed = coverageFor(agent());
  const opaque = coverageFor(agent({
    slug: "goose", adapter: "goose", observes: [], observable: false,
    attributes: [], attributable: false,
  }));

  it("admits an attributable zero", () => {
    expect(eligibleForBulkUnused(0, attributed)).toBe(true);
  });

  it("excludes an unattributable zero by default", () => {
    // Holds even if a UI makes the coverage column optional: the exclusion is the
    // safety property, the column is only its explanation.
    expect(eligibleForBulkUnused(0, opaque)).toBe(false);
  });

  it("excludes anything with recorded usage", () => {
    expect(eligibleForBulkUnused(3, attributed)).toBe(false);
  });
});

describe("explainCoverage", () => {
  it("distinguishes no adapter from an adapter that names nothing", () => {
    const unreadable = explainCoverage(coverageFor(agent({
      slug: "cursor", adapter: undefined, observes: [], observable: false,
      attributes: [], attributable: false,
    })), "Cursor");
    const opaque = explainCoverage(coverageFor(agent({
      slug: "goose", adapter: "goose", observes: [], observable: false,
      attributes: [], attributable: false,
    })), "Goose");
    expect(unreadable).toContain("no transcript adapter");
    expect(opaque).toContain("no invocation names a skill");
    expect(unreadable).not.toBe(opaque);
  });

  it("names the blind kinds for a partial agent", () => {
    const line = explainCoverage(coverageFor(agent({
      slug: "codex", adapter: "codex", observes: ["tool_call"],
      attributes: ["slash_command"], attributable: true,
    })), "Codex");
    expect(line).toContain("tool_call");
  });
});

describe("adapter capability tables agree", () => {
  it("never attributes an invocation kind it cannot observe", async () => {
    // Attribution is strictly downstream of seeing: an adapter that can name the skill
    // in an invocation must, by definition, be able to see that invocation.
    //
    // This invariant exists because the tables drifted. Ticket 13 taught the codex
    // extractor to read slash commands and updated ADAPTER_ATTRIBUTES but not
    // ADAPTER_OBSERVES, so `peek usage` printed "codex: slash_command invocations not
    // observable" directly above codex rows that could only have come from slash
    // commands. It is the second time in this effort that state split across two
    // tables drifted, and both times the fix was a test asserting the relationship
    // rather than remembering to update the second place.
    const { adapterObserves, adapterAttributes } = await import("../src/agents/builtin.js");
    const adapters = [
      "claude-code", "codex", "gemini", "goose", "opencode", "copilot-cli", "tmux", "screen",
    ];
    for (const adapter of adapters) {
      const observes = adapterObserves(adapter);
      for (const kind of adapterAttributes(adapter)) {
        expect(observes, `${adapter} attributes ${kind} but does not observe it`).toContain(kind);
      }
    }
  });

  it("holds for an adapter peek has never heard of", async () => {
    const { adapterObserves, adapterAttributes } = await import("../src/agents/builtin.js");
    expect(adapterObserves("made-up")).toEqual([]);
    expect(adapterAttributes("made-up")).toEqual([]);
  });
});
