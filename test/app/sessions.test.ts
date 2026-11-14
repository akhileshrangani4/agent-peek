// test/app/sessions.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../../src/core/engine.js";
import { Registry } from "../../src/core/registry.js";
import { SessionNotFoundError } from "../../src/core/errors.js";
import { AdapterLoader } from "../../src/app/adapters.js";
import {
  SESSION_STATUSES, SessionsService, includesTerminals, isSessionStatus, withDisplayNames,
} from "../../src/app/sessions.js";
import { makeTmpHome } from "../helpers/tmp-home.js";
import { fakeAdapter, fixtureEngine, toolOnlyTurn, userTurn } from "./fixtures.js";

describe("session rules", () => {
  it("accepts exactly the three statuses", () => {
    expect(SESSION_STATUSES).toEqual(["active", "idle", "ended"]);
    for (const status of SESSION_STATUSES) expect(isSessionStatus(status)).toBe(true);
    expect(isSessionStatus("running")).toBe(false);
    expect(isSessionStatus(undefined)).toBe(false);
    expect(isSessionStatus(1)).toBe(false);
  });

  it("includes terminals when asked, or when the adapter named is a terminal", () => {
    expect(includesTerminals({})).toBe(false);
    expect(includesTerminals({ includeTerminal: true })).toBe(true);
    expect(includesTerminals({ adapter: "tmux" })).toBe(true);
    expect(includesTerminals({ adapter: "screen" })).toBe(true);
    expect(includesTerminals({ adapter: "claude-code" })).toBe(false);
  });

  it("attaches display names, and fills a missing name only when asked", () => {
    const list = [
      { id: "fake:a", adapter: "fake", tag: "researcher" },
      { id: "fake:b", adapter: "fake", name: "kept" },
    ];
    const mcp = withDisplayNames(list);
    expect(mcp[0]).toEqual({ ...list[0], displayName: "researcher" });
    expect(mcp[0]).not.toHaveProperty("name");
    const cli = withDisplayNames(list, { fillName: true });
    expect(cli[0]!.name).toBe("researcher");
    expect(cli[1]!.name).toBe("kept");
  });
});

describe("SessionsService", () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let sessions: SessionsService;

  beforeEach(async () => {
    ({ home, cleanup } = await makeTmpHome());
    const tools = Array.from({ length: 8 }, toolOnlyTurn);
    const engine = fixtureEngine(home, [
      fakeAdapter([
        { id: "live", cwd: "/repo", messages: [userTurn("first"), ...tools, userTurn("last")] },
        { id: "child", cwd: "/repo", parentSessionId: "live", messages: [userTurn("sub")] },
        { id: "done", status: "ended", messages: [userTurn("old")] },
        { id: "idle", status: "idle", messages: [userTurn("waiting")] },
      ]),
      fakeAdapter([{ id: "pane", messages: [userTurn("$ ls")] }], "tmux"),
    ]);
    sessions = new SessionsService(engine);
  });
  afterEach(async () => { await cleanup(); });

  const ids = (list: { id: string }[]) => list.map((s) => s.id).sort();

  it("hides ended sessions and terminals by default and shows subagents", async () => {
    expect(ids(await sessions.list())).toEqual(["fake:child", "fake:idle", "fake:live"]);
  });

  it("keeps ended sessions on request or when a status is named", async () => {
    expect(ids(await sessions.list({ includeEnded: true }))).toContain("fake:done");
    expect(ids(await sessions.list({ status: "ended" }))).toEqual(["fake:done"]);
    expect(ids(await sessions.list({ status: "idle" }))).toEqual(["fake:idle"]);
  });

  it("hides subagents only when the caller asks", async () => {
    expect(ids(await sessions.list({ hideSubagents: true }))).toEqual(["fake:idle", "fake:live"]);
  });

  it("lists terminals when included or named", async () => {
    expect(ids(await sessions.list({ includeTerminal: true }))).toContain("tmux:pane");
    expect(ids(await sessions.list({ adapter: "tmux" }))).toEqual(["tmux:pane"]);
  });

  it("enumerates live agent sessions for resources, without terminals", async () => {
    expect(ids(await sessions.active())).toEqual(["fake:child", "fake:idle", "fake:live"]);
  });

  it("reports which adapters have sessions", async () => {
    expect([...await sessions.adaptersWithSessions()].sort()).toEqual(["fake", "tmux"]);
    expect(sessions.adapterNames()).toEqual(["fake", "tmux"]);
  });

  it("answers an empty presence set when discovery cannot run", async () => {
    // A regular file where the state directory belongs: the registry cannot be written.
    const blocked = mkdtempSync(join(tmpdir(), "ap-blocked-"));
    writeFileSync(join(blocked, ".agent-peek"), "not a directory");
    const loader = new AdapterLoader();
    loader.register(fakeAdapter([{ id: "x" }]));
    const broken = new SessionsService(new Engine({ registry: new Registry({ home: blocked }), loader }));
    expect((await broken.adaptersWithSessions()).size).toBe(0);
  });

  it("widens a raw window until enough visible messages fit", async () => {
    const { result, widened } = await sessions.peekVisible("fake:live", { mode: "raw", limit: 2 }, { showTools: false });
    expect(widened).toEqual({ messages: 10, wanted: 2 });
    if (result.snapshot.mode !== "raw") throw new Error("expected raw");
    expect(result.snapshot.messages.filter((m) => m.text).map((m) => m.text)).toEqual(["first", "last"]);
  });

  it("does not widen when tools are shown, a window is centred, or the mode is not raw", async () => {
    expect((await sessions.peekVisible("fake:live", { mode: "raw", limit: 2 }, { showTools: true })).widened).toBeUndefined();
    expect((await sessions.peekVisible("fake:live", { mode: "raw", limit: 2, around: 5 }, { showTools: false })).widened).toBeUndefined();
    expect((await sessions.peekVisible("fake:live", { mode: "raw" }, { showTools: false })).widened).toBeUndefined();
    const structured = await sessions.peekVisible("fake:live", { mode: "structured", limit: 2 }, { showTools: false });
    expect(structured.widened).toBeUndefined();
    expect(structured.result.snapshot.mode).toBe("structured");
  });

  it("does not report widening when the first window already holds enough", async () => {
    const { widened } = await sessions.peekVisible("fake:idle", { mode: "raw", limit: 1 }, { showTools: false });
    expect(widened).toBeUndefined();
  });

  it("serves the brief, handoff and tail views", async () => {
    expect((await sessions.view("fake:live", "brief")).snapshot.mode).toBe("brief");
    expect((await sessions.view("fake:live", "handoff")).snapshot.mode).toBe("handoff");
    const tail = (await sessions.view("fake:live", "tail")).snapshot;
    expect(tail.mode).toBe("raw");
  });

  it("peeks through the engine and surfaces its errors", async () => {
    expect((await sessions.peek("fake:idle", { mode: "brief" })).snapshot.mode).toBe("brief");
    await expect(sessions.peek("nobody")).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("tags, untags, registers and forgets", async () => {
    await sessions.list();
    await sessions.tag("fake:live", "lead");
    expect((await sessions.peek("lead", { mode: "brief" })).snapshot.mode).toBe("brief");
    await sessions.untag("fake:live");
    await expect(sessions.peek("lead")).rejects.toBeInstanceOf(SessionNotFoundError);

    const entry = await sessions.register({ id: "fake:manual", adapter: "fake", transcriptPath: "/tmp/manual" });
    expect(entry.id).toBe("fake:manual");
    await sessions.forget("fake:manual");
  });
});
