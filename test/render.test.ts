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
