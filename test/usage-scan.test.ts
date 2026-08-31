import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageStore } from "../src/usage/store.js";
import { scanAdapter, scanAll } from "../src/usage/scan.js";
import claudeCode from "../src/adapters/claude-code/index.js";
import type { Adapter } from "../src/adapters/types.js";
import type { SessionEntry } from "../src/core/types.js";

let dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const TS = "2026-08-30T12:00:00.000Z";

function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant", sessionId: "s1", cwd: "/repo", timestamp: TS,
    message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "wayfinder" } },
    ] },
    ...overrides,
  });
}

function userCommand(name: string): string {
  return JSON.stringify({
    type: "user", sessionId: "s1", cwd: "/repo", timestamp: TS,
    message: { role: "user", content: `<command-name>/${name}</command-name>` },
  });
}

/** A fixture adapter over real files, so the watermark/cursor path is exercised. */
function fileAdapter(path: string, name = "claude-code"): Adapter {
  const entry: SessionEntry = {
    id: `${name}:s1`, adapter: name, transcriptPath: path, cwd: "/repo",
    lastSeen: TS, status: "idle", sourceType: "file",
  };
  return {
    name,
    scan: async () => [entry],
    read: (e, cursor) => claudeCode.read(e, cursor),
  };
}

function write(path: string, lines: string[]): void {
  writeFileSync(path, lines.map((l) => `${l}\n`).join(""));
}

describe("scanAdapter", () => {
  it("records invocations from a transcript and watermarks the source", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, [record(), userCommand("skill-creator")]);

    const store = new UsageStore({ home });
    const result = await scanAdapter(fileAdapter(path), store);

    expect(result.bootstrap).toBe(true);
    expect(result.sourcesScanned).toBe(1);
    expect(result.invocations).toBe(2);
    const kinds = store.allInvocations().map((i) => i.sourceKind).sort();
    expect(kinds).toEqual(["slash_command", "tool_call"]);
    expect(store.getWatermark(path)?.size).toBeGreaterThan(0);
    store.close();
  });

  it("is idempotent: re-scanning an unchanged source adds nothing", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, [record()]);

    const store = new UsageStore({ home });
    const adapter = fileAdapter(path);
    await scanAdapter(adapter, store);
    const second = await scanAdapter(adapter, store);

    expect(second.sourcesScanned).toBe(0);
    expect(second.sourcesSkipped).toBe(1);
    expect(store.allInvocations()).toHaveLength(1);
    store.close();
  });

  it("counts only the new records when a transcript grows", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, [record()]);

    const store = new UsageStore({ home });
    const adapter = fileAdapter(path);
    await scanAdapter(adapter, store);
    write(path, [record(), userCommand("review")]);
    const second = await scanAdapter(adapter, store);

    expect(second.invocations).toBe(1);
    expect(store.allInvocations()).toHaveLength(2);
    store.close();
  });

  it("re-scans from zero when a transcript shrinks, without duplicating rows", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, [record(), userCommand("review"), userCommand("clear")]);

    const store = new UsageStore({ home });
    const adapter = fileAdapter(path);
    await scanAdapter(adapter, store);
    expect(store.allInvocations()).toHaveLength(3);

    // Truncation/rotation: the stored byte offset is now past EOF.
    write(path, [record()]);
    await scanAdapter(adapter, store);

    const rows = store.allInvocations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe("Skill");
    expect(store.getWatermark(path)?.msgIndex).toBe(1);
    store.close();
  });

  it("tombstones a source whose transcript has been deleted, keeping its rows", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, [record()]);

    const store = new UsageStore({ home });
    await scanAdapter(fileAdapter(path), store);
    unlinkSync(path);

    // The transcript is gone; the adapter no longer discovers it.
    const empty: Adapter = { name: "claude-code", scan: async () => [], read: claudeCode.read };
    const result = await scanAdapter(empty, store);

    expect(result.sourcesTombstoned).toBe(1);
    expect(store.tombstones().map((t) => t.sourcePath)).toEqual([path]);
    // The index is now the only remaining evidence that session happened.
    expect(store.allInvocations()).toHaveLength(1);
    store.close();
  });

  it("does not tombstone the same source twice", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, [record()]);
    const store = new UsageStore({ home });
    await scanAdapter(fileAdapter(path), store);
    unlinkSync(path);
    const empty: Adapter = { name: "claude-code", scan: async () => [], read: claudeCode.read };
    await scanAdapter(empty, store);
    const again = await scanAdapter(empty, store);
    expect(again.sourcesTombstoned).toBe(0);
    store.close();
  });

  it("handles an empty transcript without recording anything", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, []);
    const store = new UsageStore({ home });
    const result = await scanAdapter(fileAdapter(path), store);
    expect(result.invocations).toBe(0);
    expect(store.getWatermark(path)).toBeDefined();
    store.close();
  });

  it("skips terminal-backed sessions, which have no durable transcript", async () => {
    const home = tmp("peek-scan-home-");
    const store = new UsageStore({ home });
    const adapter: Adapter = {
      name: "tmux",
      scan: async () => [{
        id: "tmux:1", adapter: "tmux", transcriptPath: "tmux://1",
        lastSeen: TS, status: "active", sourceType: "terminal",
      }],
      read: async () => { throw new Error("should not be read"); },
    };
    const result = await scanAdapter(adapter, store);
    expect(result.sourcesSkipped).toBe(1);
    expect(result.errors).toHaveLength(0);
    store.close();
  });

  it("records an unreadable source as an error without aborting the run", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const good = join(dir, "good.jsonl");
    write(good, [record()]);
    const missing = join(dir, "missing.jsonl");

    const entries: SessionEntry[] = [
      { id: "claude-code:missing", adapter: "claude-code", transcriptPath: missing, lastSeen: TS, status: "idle", sourceType: "file" },
      { id: "claude-code:s1", adapter: "claude-code", transcriptPath: good, lastSeen: TS, status: "idle", sourceType: "file" },
    ];
    const adapter: Adapter = { name: "claude-code", scan: async () => entries, read: claudeCode.read };

    const store = new UsageStore({ home });
    const result = await scanAdapter(adapter, store);
    expect(result.errors).toHaveLength(1);
    expect(result.sourcesScanned).toBe(1);
    store.close();
  });

  it("surfaces a failing scan as an error rather than throwing", async () => {
    const home = tmp("peek-scan-home-");
    const store = new UsageStore({ home });
    const adapter: Adapter = {
      name: "broken",
      scan: async () => { throw new Error("no root"); },
      read: async () => { throw new Error("unused"); },
    };
    const result = await scanAdapter(adapter, store);
    expect(result.errors[0]?.message).toBe("no root");
    store.close();
  });

  it("reports bootstrap only on the first run", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, [record()]);
    const store = new UsageStore({ home });
    const adapter = fileAdapter(path);
    expect((await scanAdapter(adapter, store)).bootstrap).toBe(true);
    expect((await scanAdapter(adapter, store)).bootstrap).toBe(false);
    store.close();
  });

  it("attaches the agent id supplied by the caller, separately from the adapter", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, [record()]);
    const store = new UsageStore({ home });
    await scanAdapter(fileAdapter(path), store, { agentFor: () => "claude" });
    const row = store.allInvocations()[0];
    expect(row?.adapter).toBe("claude-code");
    expect(row?.agent).toBe("claude");
    store.close();
  });

  it("leaves the agent null when the caller cannot attribute one", async () => {
    // screen and tmux host someone else's session: adapter with no attributable agent.
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const path = join(dir, "a.jsonl");
    write(path, [record()]);
    const store = new UsageStore({ home });
    await scanAdapter(fileAdapter(path), store);
    expect(store.allInvocations()[0]?.agent).toBeNull();
    store.close();
  });

  it("scanAll merges results across adapters into one store", async () => {
    const home = tmp("peek-scan-home-");
    const dir = tmp("peek-scan-src-");
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    write(a, [record()]);
    write(b, [record(), userCommand("review")]);

    const store = new UsageStore({ home });
    const result = await scanAll([fileAdapter(a), fileAdapter(b, "codex")], store);

    expect(result.bootstrap).toBe(true);
    expect(result.sourcesScanned).toBe(2);
    // codex falls back to the default extractor: tool calls only, no slash command.
    expect(result.invocations).toBe(2);
    expect(store.observedAdapters()).toEqual(["claude-code", "codex"]);
    store.close();
  });

  it("scanAll collects errors from every adapter rather than stopping at the first", async () => {
    const home = tmp("peek-scan-home-");
    const store = new UsageStore({ home });
    const broken = (name: string): Adapter => ({
      name,
      scan: async () => { throw new Error(`${name} failed`); },
      read: async () => { throw new Error("unused"); },
    });
    const result = await scanAll([broken("one"), broken("two")], store);
    expect(result.errors.map((e) => e.message)).toEqual(["one failed", "two failed"]);
    store.close();
  });
});
