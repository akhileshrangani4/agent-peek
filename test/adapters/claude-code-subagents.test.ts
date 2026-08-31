// test/adapters/claude-code-subagents.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import claudeCode from "../../src/adapters/claude-code/index.js";
import { displayName } from "../../src/core/names.js";

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "peek-subagents-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

const PROJECT = "-Users-avi-repo";

function projectDir(): string {
  const d = join(home, ".claude", "projects", PROJECT);
  mkdirSync(d, { recursive: true });
  return d;
}

function writeParent(sessionId: string, cwd = "/Users/avi/repo"): void {
  writeFileSync(
    join(projectDir(), `${sessionId}.jsonl`),
    `${JSON.stringify({ type: "user", sessionId, cwd, timestamp: "2026-08-30T12:00:00.000Z", message: { role: "user", content: "hi" } })}\n`,
  );
}

function writeSubagent(parentId: string, agentId: string, cwd = "/Users/avi/repo"): string {
  const dir = join(projectDir(), parentId, "subagents");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `agent-${agentId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: "user",
    // A subagent transcript carries its PARENT's sessionId. Keying on it would collide
    // every subagent onto the session that spawned it.
    sessionId: parentId,
    agentId,
    isSidechain: true,
    attributionAgent: "general-purpose",
    cwd,
    timestamp: "2026-08-30T12:00:00.000Z",
    message: { role: "user", content: "go" },
  })}\n`);
  return path;
}

describe("claude-code scan: subagent sidecars", () => {
  it("discovers a subagent transcript beside its parent", async () => {
    writeParent("parent-1");
    writeSubagent("parent-1", "aaa111");
    const entries = await claudeCode.scan();
    expect(entries).toHaveLength(2);
    const sub = entries.find((e) => e.parentSessionId !== undefined);
    expect(sub?.id).toBe("claude-code:aaa111");
    expect(sub?.parentSessionId).toBe("parent-1");
  });

  it("keys a subagent on its agentId, not the parent session id in its records", async () => {
    writeParent("parent-1");
    writeSubagent("parent-1", "aaa111");
    writeSubagent("parent-1", "bbb222");
    const entries = await claudeCode.scan();
    const ids = entries.map((e) => e.id).sort();
    // Three distinct entries: the parent and two subagents that both record
    // sessionId "parent-1" internally.
    expect(ids).toEqual(["claude-code:aaa111", "claude-code:bbb222", "claude-code:parent-1"]);
  });

  it("finds a subagent whose parent transcript no longer exists", async () => {
    // Nothing guarantees parent deletion and sidecar deletion are atomic at the
    // 30-day boundary, so discovery must not be keyed on the parent surviving.
    writeSubagent("parent-gone", "ccc333");
    const entries = await claudeCode.scan();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.parentSessionId).toBe("parent-gone");
  });

  it("ignores vercel-plugin telemetry, which is not a session", async () => {
    writeParent("parent-1");
    const dir = join(projectDir(), "vercel-plugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "skill-injections.jsonl"),
      `${JSON.stringify({ event: "prompt-skill-injection", matchedSkills: ["nextjs"] })}\n`);
    const entries = await claudeCode.scan();
    expect(entries.map((e) => e.id)).toEqual(["claude-code:parent-1"]);
  });

  it("ignores any nested directory that is not a subagents sidecar", async () => {
    writeParent("parent-1");
    const memory = join(projectDir(), "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "notes.jsonl"), `${JSON.stringify({ type: "user" })}\n`);
    const nested = join(projectDir(), "parent-1", "other");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "stuff.jsonl"), `${JSON.stringify({ type: "user" })}\n`);
    const entries = await claudeCode.scan();
    expect(entries.map((e) => e.id)).toEqual(["claude-code:parent-1"]);
  });

  it("leaves top-level sessions without a parent id", async () => {
    writeParent("parent-1");
    const entries = await claudeCode.scan();
    expect(entries[0]?.parentSessionId).toBeUndefined();
  });

  it("reads a discovered subagent transcript like any other source", async () => {
    writeParent("parent-1");
    const path = writeSubagent("parent-1", "aaa111");
    const entries = await claudeCode.scan();
    const sub = entries.find((e) => e.transcriptPath === path)!;
    const read = await claudeCode.read(sub);
    expect(read.messages).toHaveLength(1);
    const raw = read.messages[0]!.raw as { isSidechain?: boolean };
    expect(raw.isSidechain).toBe(true);
  });
});

describe("displayName: subagent marker", () => {
  it("marks a subagent so it does not read as its parent", () => {
    // A subagent shares its parent's cwd, so a cwd-derived name collides.
    const parent = { id: "claude-code:p", adapter: "claude-code", cwd: "/Users/avi/repo" };
    const sub = { ...parent, id: "claude-code:a1", parentSessionId: "p" };
    expect(displayName(parent)).toBe("repo-claude");
    expect(displayName(sub)).toBe("repo-claude-sub");
  });

  it("marks a subagent that has no cwd to derive from", () => {
    expect(displayName({ id: "claude-code:a1", adapter: "claude-code", parentSessionId: "p" }))
      .toBe("a1-sub");
  });

  it("still prefers an explicit tag", () => {
    expect(displayName({ id: "claude-code:a1", adapter: "claude-code", tag: "mine", parentSessionId: "p" }))
      .toBe("mine");
  });
});
