// test/app/rules.test.ts
//
// The small shared rules every front end leans on: time, paths, the project ref, self
// identity, and how the app object is composed.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appFor, claimsService, createApp } from "../../src/app/index.js";
import { createEngine } from "../../src/app/engine.js";
import { resolveSelf } from "../../src/app/identity.js";
import { parsePathList, releaseSelector, resolveTargets } from "../../src/app/paths.js";
import { projectAt } from "../../src/app/project.js";
import { fixedClock, parseDuration, resolveInstant, systemClock } from "../../src/app/time.js";
import { makeTmpHome, withEnv } from "../helpers/tmp-home.js";
import { fakeAdapter, fixtureEngine } from "./fixtures.js";

describe("time", () => {
  it("parses durations with and without units", () => {
    expect(parseDuration("30")).toEqual({ ok: true, ms: 30_000 });
    expect(parseDuration("500ms")).toEqual({ ok: true, ms: 500 });
    expect(parseDuration(" 2m ")).toEqual({ ok: true, ms: 120_000 });
    expect(parseDuration("1H")).toEqual({ ok: true, ms: 3_600_000 });
    expect(parseDuration("7d")).toEqual({ ok: true, ms: 604_800_000 });
  });

  it("refuses unparseable and non-positive durations", () => {
    expect(parseDuration("soon")).toEqual({ ok: false, problem: "format" });
    expect(parseDuration("-1m")).toEqual({ ok: false, problem: "format" });
    expect(parseDuration("0s")).toEqual({ ok: false, problem: "non-positive" });
    expect(parseDuration("99999999999999999d")).toEqual({ ok: false, problem: "non-positive" });
  });

  it("resolves an instant from a duration back from now, or from a date", () => {
    const now = new Date("2026-11-13T12:00:00.000Z");
    expect(resolveInstant("1d", now)).toEqual({ ok: true, iso: "2026-11-12T12:00:00.000Z" });
    expect(resolveInstant("2026-08-01", now)).toEqual({ ok: true, iso: "2026-08-01T00:00:00.000Z" });
    expect(resolveInstant("0h", now)).toEqual({ ok: false, problem: "non-positive" });
    expect(resolveInstant("last tuesday", now)).toEqual({ ok: false, problem: "invalid-date" });
  });

  it("gives a fixed clock a fresh Date each call", () => {
    const clock = fixedClock("2026-11-13T12:00:00.000Z");
    const first = clock.now();
    first.setFullYear(2000);
    expect(clock.now().toISOString()).toBe("2026-11-13T12:00:00.000Z");
    expect(Math.abs(systemClock.now().getTime() - Date.now())).toBeLessThan(1000);
  });
});

describe("paths", () => {
  let home: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => { ({ home, cleanup } = await makeTmpHome()); });
  afterEach(async () => { await cleanup(); });

  it("resolves targets against the caller's directory, de-duplicated and sorted", () => {
    expect(resolveTargets(["b.ts", "./a.ts", "/abs/c.ts", "a.ts"], "/repo")).toEqual(["/abs/c.ts", "/repo/a.ts", "/repo/b.ts"]);
  });

  it("reads a path list, skipping blanks and comments and splitting multi-path lines", () => {
    writeFileSync(join(home, "a.ts"), "");
    mkdirSync(join(home, "with space"));
    const list = parsePathList("a.ts\n\n# comment\r\nwith space\nb.ts c.ts\n", home);
    expect(list.entries).toEqual(["a.ts", "with space", "b.ts", "c.ts"]);
    expect(list.missing).toEqual(["b.ts", "c.ts"]);
  });

  it("reads a UUID-shaped selector as a claim id and anything else as a path", () => {
    const id = "0b5c1a52-8d0e-4c3f-9a6b-2f1e7d9c4b3a";
    expect(releaseSelector(id, "/repo")).toBe(id);
    expect(releaseSelector("src/a.ts", "/repo")).toBe("/repo/src/a.ts");
    expect(releaseSelector("short", "/repo", { claimId: true })).toBe("short");
  });

  it("keeps the project directory exactly as the front end chose it", () => {
    expect(projectAt("relative/dir")).toEqual({ dir: "relative/dir" });
  });
});

describe("resolveSelf", () => {
  let home: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => { ({ home, cleanup } = await makeTmpHome()); });
  afterEach(async () => { await cleanup(); });

  it("is the harness session when the harness names it", async () => {
    await withEnv({ CLAUDE_SESSION_ID: "abc" }, async () => {
      expect(await resolveSelf(undefined, "/repo")).toEqual({ owner: "claude-code:abc", session: "claude-code:abc" });
    });
  });

  it("is the one live session in this directory", async () => {
    const engine = fixtureEngine(home, [fakeAdapter([{ id: "me", cwd: "/repo" }])]);
    await withEnv({ CLAUDE_SESSION_ID: "" }, async () => {
      expect(await resolveSelf(engine, "/repo/src")).toEqual({ owner: "fake:me", session: "fake:me" });
    });
  });

  it("falls back to user@host:dir, and says when two sessions made it ambiguous", async () => {
    const engine = fixtureEngine(home, [fakeAdapter([{ id: "a", cwd: "/repo" }, { id: "b", cwd: "/repo" }])]);
    await withEnv({ CLAUDE_SESSION_ID: "" }, async () => {
      const ambiguous = await resolveSelf(engine, "/repo");
      expect(ambiguous.owner).toMatch(/^.+@.+:\/repo$/);
      expect(ambiguous.session).toBeUndefined();
      expect(ambiguous.note).toMatch(/could not tell which of 2 live sessions in this directory is you \(fake:a, fake:b\)/);

      const none = await resolveSelf(engine, "/elsewhere");
      expect(none.note).toBe(`no tracked session found for this directory; using ${none.owner}.`);
    });
  });
});

describe("app composition", () => {
  let home: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => { ({ home, cleanup } = await makeTmpHome()); });
  afterEach(async () => { await cleanup(); });

  it("composes an engine with the built-in adapters, and none when told not to", async () => {
    expect((await createEngine({ home })).adapterNames()).toContain("opencode");
    expect((await createEngine({ home, withBuiltins: false })).adapterNames()).toEqual([]);
  });

  it("builds every service over one engine and one clock", async () => {
    const engine = fixtureEngine(home, [fakeAdapter([{ id: "x" }])]);
    const clock = fixedClock("2026-11-13T12:00:00.000Z");
    const app = appFor(engine, { clock, home });
    expect(app.engine).toBe(engine);
    expect(app.clock).toBe(clock);
    expect(app.sessions.adapterNames()).toEqual(["fake"]);
    expect((await app.claims.claim({ cwd: "/repo", files: ["a.ts"], self: { owner: "me" }, ttlMs: 60_000 })).createdAt)
      .toBe("2026-11-13T12:00:00.000Z");
  });

  it("uses an injected engine, or composes one", async () => {
    const engine = fixtureEngine(home, []);
    expect((await createApp({ engine, home })).engine).toBe(engine);
    const composed = await createApp({ home, withBuiltins: false });
    expect(composed.sessions.adapterNames()).toEqual([]);
    expect(composed.clock).toBe(systemClock);
  });

  it("builds claims alone, without an engine", async () => {
    const claims = claimsService({ home, clock: fixedClock("2026-11-13T12:00:00.000Z") });
    expect(await claims.active()).toEqual([]);
  });
});
