// test/adapters/claude-code.test.ts
import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import claudeCode from "../../src/adapters/claude-code/index.js";
import type { SessionEntry } from "../../src/core/types.js";
import { encodeCursor } from "../../src/core/cursor.js";
import { runAdapterConformance } from "../helpers/adapter-conformance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(__dirname, "../fixtures/claude-code", name, "transcript.jsonl");

const entry = (path: string, id = "claude-code:test"): SessionEntry => ({
  id,
  adapter: "claude-code",
  transcriptPath: path,
  lastSeen: new Date().toISOString(),
  status: "active",
});

describe("claude-code adapter", () => {
  it("scan finds nothing under empty $HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "ac-empty-"));
    process.env.HOME = home;
    const sessions = await claudeCode.scan();
    expect(sessions).toEqual([]);
  });

  it("reads multi-turn fixture", async () => {
    const r = await claudeCode.read(entry(fixture("multi-turn")));
    expect(r.messages.length).toBe(5);
    expect(r.messages[0]!.role).toBe("user");
    expect(r.messages[0]!.text).toBe("refactor auth");
    // The 3rd record (index 2) is the assistant tool_use record.
    expect(r.messages[2]!.toolCalls?.[0]?.name).toBe("Read");
    // The 4th record (index 3) is a top-level type:"user" with tool_result content.
    expect(r.messages[3]!.role).toBe("tool");
    expect(r.eof).toBe(true);
  });

  it("returns empty for empty fixture", async () => {
    const r = await claudeCode.read(entry(fixture("empty")));
    expect(r.messages.length).toBe(0);
  });

  it("ignores corrupt trailing line (writer in flight)", async () => {
    const r = await claudeCode.read(entry(fixture("corrupt-tail")));
    expect(r.messages.length).toBe(2);
  });

  it("cursor diff returns only new messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ac-cursor-"));
    const path = join(dir, "t.jsonl");
    await writeFile(path,
      `{"type":"user","sessionId":"x","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"first"}}\n`
      + `{"type":"assistant","sessionId":"x","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n`,
      "utf8");
    const r1 = await claudeCode.read(entry(path));
    expect(r1.messages.length).toBe(2);

    await appendFile(path,
      `{"type":"user","sessionId":"x","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"second"}}\n`,
      "utf8");

    const r2 = await claudeCode.read(entry(path), r1.nextCursor);
    expect(r2.messages.length).toBe(1);
    expect(r2.messages[0]!.text).toBe("second");
  });

  it("rejects cursor from another adapter", async () => {
    const bad = encodeCursor({ adapter: "codex", byteOffset: 0, msgIndex: 0 });
    await expect(claudeCode.read(entry(fixture("multi-turn")), bad)).rejects.toThrow();
  });

  it("passes adapter conformance suite (multi-turn)", async () => {
    await runAdapterConformance(claudeCode, {
      name: "multi-turn",
      entry: entry(fixture("multi-turn")),
      expectMinMessages: 5,
    });
  });

  it("scan picks up sessions under fake $HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "ac-home-"));
    const projDir = join(home, ".claude", "projects", "-tmp-repo");
    await mkdir(projDir, { recursive: true });
    const tx = join(projDir, "abc.jsonl");
    await writeFile(tx, `{"type":"user","sessionId":"abc","cwd":"/tmp/repo","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n`, "utf8");
    process.env.HOME = home;
    const sessions = await claudeCode.scan();
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe("claude-code:abc");
    expect(sessions[0]!.cwd).toBe("/tmp/repo");
    expect(sessions[0]!.transcriptPath).toBe(tx);
  });
});
