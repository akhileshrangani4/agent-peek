import { describe, expect, it, afterEach } from "vitest";
import { num, overflow, padEnd, padStart, terminalWidth, colorEnabled } from "../src/cli/render.js";

const saved = { ...process.env };
afterEach(() => {
  process.env.NO_COLOR = saved.NO_COLOR;
  process.env.FORCE_COLOR = saved.FORCE_COLOR;
  process.env.COLUMNS = saved.COLUMNS;
  if (saved.NO_COLOR === undefined) delete process.env.NO_COLOR;
  if (saved.FORCE_COLOR === undefined) delete process.env.FORCE_COLOR;
  if (saved.COLUMNS === undefined) delete process.env.COLUMNS;
});

describe("num", () => {
  it("separates thousands so two surfaces cannot disagree", () => {
    expect(num(118873)).toBe("118,873");
    expect(num(0)).toBe("0");
  });
});

describe("overflow", () => {
  it("uses one wording for the more line", () => {
    expect(overflow(8, 140)).toBe("132 more");
    expect(overflow(8, 140, "peek skills --segment reclaimable"))
      .toBe("132 more · peek skills --segment reclaimable");
  });
});

describe("padding", () => {
  it("measures in characters, not bytes", () => {
    // A sparkline cell is three bytes per character; a byte-based pad would under-pad
    // it and skew every column to its right. This trap has bitten three sessions.
    expect(padEnd("▁▂▃", 5)).toBe("▁▂▃  ");
    expect(padStart("▁▂▃", 5)).toBe("  ▁▂▃");
  });

  it("never truncates while padding", () => {
    expect(padEnd("reclaimable", 4)).toBe("reclaimable");
  });
});

describe("terminalWidth", () => {
  it("treats 80 as a floor to degrade to, not a target", () => {
    expect(terminalWidth(120)).toBe(120);
    expect(terminalWidth(200)).toBe(120);
    expect(terminalWidth(10)).toBe(40);
  });

  it("reads COLUMNS when there is no tty", () => {
    process.env.COLUMNS = "96";
    expect(terminalWidth()).toBe(process.stdout.columns ? terminalWidth() : 96);
  });
});

describe("colorEnabled", () => {
  it("honours NO_COLOR above everything", () => {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled()).toBe(false);
  });

  it("honours FORCE_COLOR so --color can survive a pipe", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(colorEnabled()).toBe(true);
  });
});

describe("segment naming (ticket 15)", () => {
  it("accepts every label it shows on screen", async () => {
    // The header read "reclaimable", the id was `archivable`, and the flag took only
    // the id — so a user read the word, typed it, and got an empty result, which reads
    // as "nothing here" rather than "wrong word". Same shape as the observes/attributes
    // invariant: two representations of one fact that must not drift.
    const { segmentWords, resolveSegment } = await import("../src/cli/skills-report.js");
    for (const { id, label } of segmentWords()) {
      expect(resolveSegment(label), `label shown as "${label}"`).toBe(id);
      expect(resolveSegment(id), `id "${id}"`).toBe(id);
    }
  });

  it("tolerates the spacing a user would actually type", async () => {
    const { resolveSegment } = await import("../src/cli/skills-report.js");
    expect(resolveSegment("in use")).toBe("in-use");
    expect(resolveSegment("In-Use")).toBe("in-use");
    expect(resolveSegment("READ-ONLY")).toBe("read-only");
  });

  it("returns undefined for a word it does not know, rather than an empty result", async () => {
    const { resolveSegment } = await import("../src/cli/skills-report.js");
    expect(resolveSegment("nonsense")).toBeUndefined();
  });
});

describe("sparkline", () => {
  it("renders one cell per bucket", async () => {
    const { sparkline } = await import("../src/cli/render.js");
    expect([...sparkline([0, 1, 2, 3])].length).toBe(4);
  });

  it("scales to the row's own maximum, so a quiet skill is still legible", async () => {
    const { sparkline } = await import("../src/cli/render.js");
    expect(sparkline([0, 4])).toBe("▁█");
    expect(sparkline([0, 400])).toBe("▁█");
  });

  it("is empty for no data rather than throwing", async () => {
    const { sparkline, sparklineBlank } = await import("../src/cli/render.js");
    expect(sparkline([])).toBe("");
    expect(sparklineBlank(4)).toBe("────");
  });
});

describe("usage series (ticket 15)", () => {
  it("keys buckets by the dimension's own value", async () => {
    // peek usage rows display the invoked name verbatim, so the series keys on that
    // rather than on a resolved bare name as the skills report does. Keying either one
    // the other way draws an empty sparkline for every plugin-qualified skill.
    const { usageSeriesFor } = await import("../src/usage/report.js");
    const { UsageStore } = await import("../src/usage/store.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const home = mkdtempSync(join(tmpdir(), "peek-series-"));
    const store = new UsageStore({ home });
    const day = new Date(Date.now() - 2 * 86_400_000).toISOString();
    store.recordSource([{
      sourcePath: "/t/a.jsonl", msgIndex: 1, callIndex: 0, sourceKind: "tool_call",
      adapter: "claude-code", agent: "claude-code", sessionId: "s",
      timestamp: day, tool: "Skill", skill: "plugin:name", cwd: null, status: null,
      sidechain: false, attributionAgent: null, nativeCallId: null,
    }], {
      sourcePath: "/t/a.jsonl", adapter: "claude-code", sessionId: "s", cursor: null,
      msgIndex: 1, size: 1, mtimeMs: 1, scannedAt: day, deleted: false,
    });

    const { series, cells } = usageSeriesFor(store, { skillsOnly: true }, "skill");
    expect(series.has("plugin:name")).toBe(true);
    expect(series.get("plugin:name")).toHaveLength(cells);
    expect(series.get("plugin:name")!.reduce((a, b) => a + b, 0)).toBe(1);
    store.close();
    rmSync(home, { recursive: true, force: true });
  });
});
