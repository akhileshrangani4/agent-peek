import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { Registry } from "../../src/core/registry.js";
import { AdapterLoader } from "../../src/adapters/loader.js";
import { makeTmpHome } from "../helpers/tmp-home.js";
import { SessionNotFoundError, AmbiguousSelectorError } from "../../src/core/errors.js";
import type { Adapter } from "../../src/adapters/types.js";
import type { SessionEntry, RawMessage } from "../../src/core/types.js";
import { encodeCursor } from "../../src/core/cursor.js";
import { decodeCoordinationCursor } from "../../src/core/coordination.js";

const makeFakeAdapter = (rows: Record<string, RawMessage[]>): Adapter => ({
  name: "fake",
  async scan() {
    return Object.keys(rows).map((id) => ({
      id: `fake:${id}`,
      adapter: "fake",
      transcriptPath: `/tmp/${id}`,
      lastSeen: new Date().toISOString(),
      status: "active" as const,
    }));
  },
  async read(entry, cursor) {
    const id = entry.id.replace("fake:", "");
    const all = rows[id] ?? [];
    let from = 0;
    if (cursor) {
      const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      from = c.msgIndex ?? 0;
    }
    const messages = all.slice(from);
    return {
      messages,
      nextCursor: encodeCursor({ adapter: "fake", byteOffset: 0, msgIndex: all.length }),
      eof: true,
    };
  },
});

describe("Engine", () => {
  let home: string, cleanup: () => Promise<void>;
  let engine: Engine;
  let registry: Registry;
  let loader: AdapterLoader;

  beforeEach(async () => {
    ({ home, cleanup } = await makeTmpHome());
    registry = new Registry({
      home,
      lockRetries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
    });
    loader = new AdapterLoader();
    loader.register(makeFakeAdapter({
      a: [
        { role: "user", text: "do X", raw: {} },
        { role: "assistant", text: "ok", toolCalls: [{ name: "Read", input: { path: "src/core/engine.ts" }, status: "pending" }], raw: {} },
      ],
      b: [
        { role: "user", text: "second", raw: {} },
        { role: "assistant", toolCalls: [{ name: "Edit", input: { path: "src/core/engine.ts" }, status: "pending" }], raw: {} },
      ],
    }));
    engine = new Engine({ registry, loader });
  });
  afterEach(async () => { await cleanup(); });

  it("list scans adapters and merges into registry", async () => {
    const list = await engine.list();
    expect(list.length).toBe(2);
    expect((await registry.list()).length).toBe(2);
  });

  it("list with adapter filter only scans that adapter", async () => {
    loader.register({
      name: "broken",
      async scan() {
        throw new Error("should not scan");
      },
      async read() {
        throw new Error("unused");
      },
    });
    const list = await engine.list({ adapter: "fake" });
    expect(list.map((entry) => entry.adapter)).toEqual(["fake", "fake"]);
  });

  it("adapterNames returns registered adapters without scanning", () => {
    loader.register({
      name: "broken",
      async scan() {
        throw new Error("should not scan");
      },
      async read() {
        throw new Error("unused");
      },
    });
    expect(engine.adapterNames()).toEqual(["broken", "fake"]);
  });

  it("peek by exact id returns raw snapshot", async () => {
    const r = await engine.peek("fake:a", { mode: "raw" });
    expect(r.snapshot.mode).toBe("raw");
    expect((r.snapshot as any).messages.length).toBe(2);
  });

  it("peek by adapter-prefixed id only scans that adapter", async () => {
    loader.register({
      name: "broken",
      async scan() {
        throw new Error("should not scan");
      },
      async read() {
        throw new Error("unused");
      },
    });
    const r = await engine.peek("fake:a", { mode: "raw" });
    expect((r.snapshot as any).sessionId).toBe("fake:a");
  });

  it("peek by tag works after tag()", async () => {
    await engine.list();
    await engine.tag("fake:a", "researcher");
    const r = await engine.peek("researcher", { mode: "structured" });
    expect((r.snapshot as any).mode).toBe("structured");
  });

  it("peek by display name works when unique", async () => {
    await registry.upsert({
      id: "fake:named",
      adapter: "fake",
      transcriptPath: "/tmp/named",
      name: "worker",
      lastSeen: new Date().toISOString(),
      status: "active",
    });
    const r = await engine.peek("worker", { mode: "raw" });
    expect((r.snapshot as any).sessionId).toBe("fake:named");
  });

  it("peek by display name resolves duplicate names by list order", async () => {
    await registry.upsert({
      id: "fake:newer",
      adapter: "fake",
      transcriptPath: "/tmp/newer",
      name: "worker",
      lastSeen: "2026-01-02T00:00:00.000Z",
      status: "active",
    });
    await registry.upsert({
      id: "fake:older",
      adapter: "fake",
      transcriptPath: "/tmp/older",
      name: "worker",
      lastSeen: "2026-01-01T00:00:00.000Z",
      status: "active",
    });
    const latest = await engine.peek("worker", { mode: "raw" });
    const next = await engine.peek("worker-2", { mode: "raw" });
    expect((latest.snapshot as any).sessionId).toBe("fake:newer");
    expect((next.snapshot as any).sessionId).toBe("fake:older");
  });

  it("peek with cursor returns delta", async () => {
    await engine.list();
    const r1 = await engine.peek("fake:a", { mode: "raw" });
    const r2 = await engine.peek("fake:a", { mode: "raw", since: r1.nextCursor });
    expect((r2.snapshot as any).messages.length).toBe(0);
  });

  it("coordinate summarizes sessions, changes, and overlap hints", async () => {
    await engine.list();
    const now = Date.now();
    await registry.upsert({
      id: "fake:a", adapter: "fake", transcriptPath: "/tmp/a",
      cwd: "/work/repo", lastSeen: new Date(now).toISOString(), status: "active",
    });
    await registry.upsert({
      id: "fake:b", adapter: "fake", transcriptPath: "/tmp/b",
      cwd: "/work/repo", lastSeen: new Date(now - 1000).toISOString(), status: "active",
    });
    const digest = await engine.coordinate({ cwd: "/work" });
    expect(digest.mode).toBe("coordination");
    expect(digest.firstSnapshot).toBe(true);
    expect(digest.sessionCount).toBe(2);
    expect(digest.newSessionCount).toBe(2);
    expect(digest.changedSessionCount).toBe(0);
    expect(digest.sessions.map((session) => session.displayName)).toEqual(["repo-fake", "repo-fake-2"]);
    expect(digest.sessions[0]!.touchedFiles).toEqual(["/work/repo/src/core/engine.ts"]);
    expect(digest.sessions[0]!.recentFiles).toEqual(["/work/repo/src/core/engine.ts"]);
    expect(digest.sessions[0]!.knownFiles).toEqual(["/work/repo/src/core/engine.ts"]);
    expect(digest.sessions[0]!.hotFiles).toEqual(["/work/repo/src/core/engine.ts"]);
    expect(digest.sessions.map((session) => session.intent)).toEqual(["reading", "writing"]);
    expect(digest.sessions[1]!.activeWritingFiles).toEqual(["/work/repo/src/core/engine.ts"]);
    expect(digest.sessions[1]!.recentWritingFiles).toEqual(["/work/repo/src/core/engine.ts"]);
    expect(digest.sessions[1]!.writingFileEvents[0]).toMatchObject({
      file: "/work/repo/src/core/engine.ts",
      active: true,
    });
    expect(digest.sessions[1]!.writingFiles).toEqual(["/work/repo/src/core/engine.ts"]);
    expect(digest.overlapHints.some((hint) => hint.kind === "cwd")).toBe(false);
    const overlap = digest.overlapHints.find((hint) => hint.kind === "file");
    expect(overlap?.severity).toBe("medium");
    expect(overlap?.lastActivityAt).toBeTruthy();
    expect(overlap?.lastWritingAt).toBeTruthy();
    expect(overlap?.participants.find((participant) => participant.id === "fake:b")).toMatchObject({
      activeWriting: true,
      lastWritingAt: expect.any(String),
    });

    const next = await engine.coordinate({ cwd: "/work", since: digest.nextCursor });
    expect(next.firstSnapshot).toBe(false);
    expect(next.changedSessionCount).toBe(0);
  });

  it("coordinate reuses cursor session state for unchanged follow-up digests", async () => {
    const registry2 = new Registry({
      home,
      lockRetries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
    });
    const loader2 = new AdapterLoader();
    let fullReads = 0;
    let cursorReads = 0;
    const rows: Record<string, RawMessage[]> = {
      a: [
        { role: "user", text: "edit engine", raw: {} },
        { role: "assistant", toolCalls: [{ name: "Read", input: { path: "src/core/engine.ts" }, status: "pending" }], raw: {} },
      ],
      b: [
        { role: "user", text: "review engine", raw: {} },
        { role: "assistant", toolCalls: [{ name: "Read", input: { path: "src/core/engine.ts" }, status: "pending" }], raw: {} },
      ],
    };
    loader2.register({
      name: "fake",
      async scan() {
        return Object.keys(rows).map((id) => ({
          id: `fake:${id}`,
          adapter: "fake",
          transcriptPath: `/tmp/${id}`,
          cwd: "/work/repo",
          lastSeen: new Date().toISOString(),
          status: "active" as const,
        }));
      },
      async read(entry, cursor) {
        if (cursor) cursorReads++;
        else fullReads++;
        const id = entry.id.replace("fake:", "");
        const all = rows[id] ?? [];
        let from = 0;
        if (cursor) {
          const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
          from = c.msgIndex ?? 0;
        }
        return {
          messages: all.slice(from),
          nextCursor: encodeCursor({ adapter: "fake", byteOffset: 0, msgIndex: all.length }),
          eof: true,
        };
      },
    });
    const engine2 = new Engine({ registry: registry2, loader: loader2 });

    const first = await engine2.coordinate({ cwd: "/work" });
    const second = await engine2.coordinate({ cwd: "/work", since: first.nextCursor });

    expect(fullReads).toBe(2);
    expect(cursorReads).toBe(2);
    expect(second.changedSessionCount).toBe(0);
    expect(second.sessions[0]!.touchedFiles).toEqual(["/work/repo/src/core/engine.ts"]);
    expect(second.sessions[0]!.recentFiles).toEqual([]);
    expect(second.sessions[0]!.knownFiles).toEqual(["/work/repo/src/core/engine.ts"]);
    expect(second.sessions[0]!.hotFiles).toEqual([]);
    expect(second.sessions[0]!.intent).toBe("reading");
    expect(second.overlapHints).toEqual([]);
  });

  it("coordinate escalates one writer with multiple readers to high severity", async () => {
    const registry2 = new Registry({
      home,
      lockRetries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
    });
    const loader2 = new AdapterLoader();
    const rows: Record<string, RawMessage[]> = {
      writer: [
        { role: "user", text: "edit engine", raw: {} },
        { role: "assistant", toolCalls: [{ name: "Edit", input: { path: "src/core/engine.ts" }, status: "pending" }], raw: {} },
      ],
      r1: [{ role: "assistant", toolCalls: [{ name: "Read", input: { path: "src/core/engine.ts" } }], raw: {} }],
      r2: [{ role: "assistant", toolCalls: [{ name: "Read", input: { path: "src/core/engine.ts" } }], raw: {} }],
      r3: [{ role: "assistant", toolCalls: [{ name: "Read", input: { path: "src/core/engine.ts" } }], raw: {} }],
    };
    loader2.register(makeFakeAdapter(rows));
    const engine2 = new Engine({ registry: registry2, loader: loader2 });
    await engine2.list();
    for (const id of Object.keys(rows)) {
      await registry2.upsert({
        id: `fake:${id}`, adapter: "fake", transcriptPath: `/tmp/${id}`,
        cwd: "/work/repo", lastSeen: new Date().toISOString(), status: "active",
      });
    }

    const digest = await engine2.coordinate({ cwd: "/work" });

    const fileHint = digest.overlapHints.find((hint) => hint.kind === "file" && hint.file?.endsWith("src/core/engine.ts"));
    expect(fileHint?.severity).toBe("high");
    expect(fileHint?.message).toMatch(/also seen by 3 sessions/);
  });

  it("coordinate filters to writing sessions", async () => {
    await engine.list();
    const now = Date.now();
    await registry.upsert({
      id: "fake:a", adapter: "fake", transcriptPath: "/tmp/a",
      cwd: "/work/repo", lastSeen: new Date(now).toISOString(), status: "active",
    });
    await registry.upsert({
      id: "fake:b", adapter: "fake", transcriptPath: "/tmp/b",
      cwd: "/work/repo", lastSeen: new Date(now - 1000).toISOString(), status: "active",
    });

    const digest = await engine.coordinate({ cwd: "/work", writingOnly: true });

    expect(digest.sessionCount).toBe(1);
    expect(digest.shownSessionCount).toBe(1);
    expect(digest.totalSessionCount).toBe(2);
    expect(digest.filteredSessionCount).toBe(1);
    expect(digest.sessions[0]!.id).toBe("fake:b");
    expect(digest.sessions[0]!.intent).toBe("writing");
  });

  it("coordinate carries active writing overlap across unchanged cursor polls", async () => {
    const registry2 = new Registry({
      home,
      lockRetries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
    });
    const loader2 = new AdapterLoader();
    const rows: Record<string, RawMessage[]> = {
      writer: [
        { role: "user", text: "edit engine", raw: {} },
        { role: "assistant", toolCalls: [{ name: "Edit", input: { path: "src/core/engine.ts" }, status: "pending" }], raw: {} },
      ],
      reader: [
        { role: "user", text: "read engine", raw: {} },
        { role: "assistant", toolCalls: [{ name: "Read", input: { path: "src/core/engine.ts" } }], raw: {} },
      ],
    };
    loader2.register(makeFakeAdapter(rows));
    const engine2 = new Engine({ registry: registry2, loader: loader2 });
    await engine2.list();
    for (const id of Object.keys(rows)) {
      await registry2.upsert({
        id: `fake:${id}`, adapter: "fake", transcriptPath: `/tmp/${id}`,
        cwd: "/work/repo", lastSeen: new Date().toISOString(), status: "active",
      });
    }

    const first = await engine2.coordinate({ cwd: "/work" });
    const second = await engine2.coordinate({ cwd: "/work", since: first.nextCursor });

    expect(second.changedSessionCount).toBe(0);
    expect(second.sessions.find((session) => session.id === "fake:writer")?.writingFiles).toEqual([
      "/work/repo/src/core/engine.ts",
    ]);
    expect(second.overlapHints.find((hint) => hint.file?.endsWith("src/core/engine.ts"))?.severity).toBe("medium");
  });

  it("coordinate expires stale writing state for idle sessions", async () => {
    const registry2 = new Registry({
      home,
      lockRetries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
    });
    const loader2 = new AdapterLoader();
    loader2.register({
      name: "fake",
      async scan() {
        return [{
          id: "fake:old-writer",
          adapter: "fake",
          transcriptPath: "/tmp/old-writer",
          cwd: "/work/repo",
          lastSeen: "2026-01-01T00:00:00.000Z",
          status: "idle" as const,
        }];
      },
      async read() {
        return {
          messages: [
            { role: "user", text: "edit engine", raw: {} },
            { role: "assistant", toolCalls: [{ name: "Edit", input: { path: "src/core/engine.ts" } }], raw: {} },
          ],
          nextCursor: encodeCursor({ adapter: "fake", byteOffset: 0, msgIndex: 2 }),
          eof: true,
        };
      },
    });
    const engine2 = new Engine({ registry: registry2, loader: loader2 });

    const digest = await engine2.coordinate({ cwd: "/work" });
    const writingOnly = await engine2.coordinate({ cwd: "/work", writingOnly: true });

    expect(digest.sessions[0]!.writingFiles).toEqual([]);
    expect(digest.sessions[0]!.intent).toBe("reading");
    expect(writingOnly.sessionCount).toBe(0);
  });

  it("coordinate keeps readable sessions when one session read fails", async () => {
    const registry2 = new Registry({
      home,
      lockRetries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
    });
    const loader2 = new AdapterLoader();
    loader2.register({
      name: "fake",
      async scan() {
        return ["ok", "bad"].map((id) => ({
          id: `fake:${id}`,
          adapter: "fake",
          transcriptPath: `/tmp/${id}`,
          cwd: "/work/repo",
          lastSeen: new Date().toISOString(),
          status: "active" as const,
        }));
      },
      async read(entry) {
        if (entry.id === "fake:bad") throw new Error("unreadable");
        return {
          messages: [
            { role: "user", text: "do work", raw: {} },
            { role: "assistant", toolCalls: [{ name: "Read", input: { path: "src/core/engine.ts" } }], raw: {} },
          ],
          nextCursor: encodeCursor({ adapter: "fake", byteOffset: 0, msgIndex: 2 }),
          eof: true,
        };
      },
    });
    const engine2 = new Engine({ registry: registry2, loader: loader2 });

    const digest = await engine2.coordinate({ cwd: "/work" });

    expect(digest.sessionCount).toBe(2);
    expect(digest.sessions.find((session) => session.id === "fake:ok")?.currentTask).toBe("do work");
    expect(digest.sessions.find((session) => session.id === "fake:bad")?.error).toBe("unreadable");
    const cursor = decodeCoordinationCursor(digest.nextCursor);
    expect(cursor.sessions["fake:ok"]).toBeTruthy();
    expect(cursor.sessions["fake:bad"]).toBeUndefined();
  });

  it("SessionNotFoundError for unknown selector", async () => {
    await expect(engine.peek("nope")).rejects.toThrow(SessionNotFoundError);
  });

  it("AmbiguousSelectorError when cwd matches >1 session", async () => {
    await engine.list();
    await registry.upsert({
      id: "fake:a", adapter: "fake", transcriptPath: "/tmp/a",
      cwd: "/work", lastSeen: new Date().toISOString(), status: "active",
    });
    await registry.upsert({
      id: "fake:b", adapter: "fake", transcriptPath: "/tmp/b",
      cwd: "/work", lastSeen: new Date().toISOString(), status: "active",
    });
    await expect(engine.peek("/work")).rejects.toThrow(AmbiguousSelectorError);
  });

  it("register adds entry with given tag", async () => {
    await engine.register({
      id: "fake:c", adapter: "fake", transcriptPath: "/tmp/c", tag: "side",
    });
    const got = await registry.get("fake:c");
    expect(got?.tag).toBe("side");
  });

  it("untag clears the tag", async () => {
    await engine.list();
    await engine.tag("fake:a", "researcher");
    expect((await registry.get("fake:a"))?.tag).toBe("researcher");
    await engine.untag("fake:a");
    expect((await registry.get("fake:a"))?.tag).toBeUndefined();
  });
});
