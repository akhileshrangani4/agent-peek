// test/unit/cli-paths.test.ts
//
// Presentation invariants for the commands this session owns (peek agents, list,
// doctor). They are tests rather than conventions because both of the state-drift bugs
// in this effort came from two places agreeing only by convention.
import { describe, it, expect } from "vitest";
import { displayWidth, fit, shortenPath } from "../../src/cli/paths.js";

describe("displayWidth", () => {
  it("counts characters, not bytes", () => {
    // `awk '{print length}'` reports 3 for a single ellipsis and a layout gets redesigned
    // around a limit it never exceeded.
    expect(displayWidth("…")).toBe(1);
    expect(Buffer.byteLength("…")).toBe(3);
    expect(displayWidth("~/…/avi/mangrove-ziconium")).toBe(25);
  });

  it("ignores colour codes, so a styled cell still aligns", () => {
    expect(displayWidth("[32mready[0m")).toBe(5);
  });
});

describe("shortenPath", () => {
  const home = "/Users/avi";

  it("keeps the segments a reader identifies a session by", () => {
    const path = `${home}/.superset/worktrees/94fce017-5ef7-4a1a-ad79-10405254c6b0/avi/mangrove-ziconium`;
    const out = shortenPath(path, 22, home);
    expect(displayWidth(out)).toBeLessThanOrEqual(22);
    // The UUID is noise; the tail is the answer.
    expect(out).toContain("mangrove-ziconium");
    expect(out).not.toContain("94fce017");
  });

  it("collapses home and leaves a short path alone", () => {
    expect(shortenPath(`${home}/work`, 30, home)).toBe("~/work");
    expect(shortenPath("/tmp/x", 30, home)).toBe("/tmp/x");
  });

  it("never exceeds the budget, even when the tail alone is too long", () => {
    const path = `${home}/a/${"z".repeat(80)}`;
    expect(displayWidth(shortenPath(path, 12, home))).toBeLessThanOrEqual(12);
  });
});

describe("fit", () => {
  it("marks that something was cut and stays within budget", () => {
    expect(fit("abcdefghij", 5)).toBe("abcd…");
    expect(displayWidth(fit("abcdefghij", 5))).toBe(5);
    expect(fit("abc", 5)).toBe("abc");
  });
});
