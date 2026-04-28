import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { Registry } from "../../src/core/registry.js";
import { AdapterLoader } from "../../src/adapters/loader.js";
import { makeTmpHome } from "../helpers/tmp-home.js";
import { SessionNotFoundError, AmbiguousSelectorError } from "../../src/core/errors.js";
import type { Adapter } from "../../src/adapters/types.js";
import type { SessionEntry, RawMessage } from "../../src/core/types.js";
import { encodeCursor } from "../../src/core/cursor.js";

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
      a: [{ role: "user", text: "do X", raw: {} }, { role: "assistant", text: "ok", raw: {} }],
      b: [{ role: "user", text: "second", raw: {} }],
    }));
    engine = new Engine({ registry, loader });
  });
  afterEach(async () => { await cleanup(); });

  it("list scans adapters and merges into registry", async () => {
    const list = await engine.list();
    expect(list.length).toBe(2);
    expect((await registry.list()).length).toBe(2);
  });

  it("peek by exact id returns raw snapshot", async () => {
    await engine.list();
    const r = await engine.peek("fake:a", { mode: "raw" });
    expect(r.snapshot.mode).toBe("raw");
    expect((r.snapshot as any).messages.length).toBe(2);
  });

  it("peek by tag works after tag()", async () => {
    await engine.list();
    await engine.tag("fake:a", "researcher");
    const r = await engine.peek("researcher", { mode: "structured" });
    expect((r.snapshot as any).mode).toBe("structured");
  });

  it("peek with cursor returns delta", async () => {
    await engine.list();
    const r1 = await engine.peek("fake:a", { mode: "raw" });
    const r2 = await engine.peek("fake:a", { mode: "raw", since: r1.nextCursor });
    expect((r2.snapshot as any).messages.length).toBe(0);
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
});
