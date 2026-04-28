// test/unit/registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Registry } from "../../src/core/registry.js";
import { makeTmpHome } from "../helpers/tmp-home.js";
import type { SessionEntry } from "../../src/core/types.js";

describe("Registry", () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let reg: Registry;

  beforeEach(async () => {
    ({ home, cleanup } = await makeTmpHome());
    reg = new Registry({
      home,
      lockRetries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
    });
  });
  afterEach(async () => { await cleanup(); });

  const entry = (over: Partial<SessionEntry> = {}): SessionEntry => ({
    id: "claude-code:abc",
    adapter: "claude-code",
    transcriptPath: "/tmp/abc.jsonl",
    lastSeen: new Date().toISOString(),
    status: "active",
    ...over,
  });

  it("starts empty", async () => {
    expect(await reg.list()).toEqual([]);
  });

  it("upsert + list", async () => {
    await reg.upsert(entry());
    const list = await reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("claude-code:abc");
  });

  it("upsert merges by id", async () => {
    await reg.upsert(entry({ tag: "v1" }));
    await reg.upsert(entry({ tag: "v2" }));
    const list = await reg.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.tag).toBe("v2");
  });

  it("get by id", async () => {
    await reg.upsert(entry());
    expect((await reg.get("claude-code:abc"))?.tag).toBeUndefined();
  });

  it("remove drops entry", async () => {
    await reg.upsert(entry());
    await reg.remove("claude-code:abc");
    expect(await reg.list()).toEqual([]);
  });

  it("flips stale entries to ended", async () => {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await reg.upsert(entry({ lastSeen: old, status: "active" }));
    await reg.pruneStale();
    const got = await reg.get("claude-code:abc");
    expect(got?.status).toBe("ended");
  });

  it("backs up corrupt registry and starts fresh", async () => {
    const { writeFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(home, ".agent-peek", "registry.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".agent-peek"), { recursive: true });
    await writeFile(path, "{not json", "utf8");
    const fresh = new Registry({ home });
    expect(await fresh.list()).toEqual([]);
    const files = await readdir(join(home, ".agent-peek"));
    expect(files.some((f) => f.startsWith("registry.corrupt-"))).toBe(true);
  });

  it("survives concurrent upserts", async () => {
    await Promise.all(
      Array.from({ length: 20 }).map((_, i) =>
        reg.upsert(entry({ id: `claude-code:s${i}` })),
      ),
    );
    const list = await reg.list();
    expect(list).toHaveLength(20);
  });
});
