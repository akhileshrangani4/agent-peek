// test/adapters/gemini.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import gemini from "../../src/adapters/gemini/index.js";
import { parseMessage } from "../../src/adapters/gemini/parse.js";
import type { SessionEntry } from "../../src/core/types.js";
import { encodeCursor } from "../../src/core/cursor.js";
import { runAdapterConformance } from "../helpers/adapter-conformance.js";
import { withEnv } from "../helpers/tmp-home.js";

const entry = (path: string, id = "gemini:test"): SessionEntry => ({
  id,
  adapter: "gemini",
  transcriptPath: path,
  lastSeen: new Date().toISOString(),
  status: "active",
});

describe("gemini adapter", () => {
  it("scan finds nothing under empty $HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "gm-empty-"));
    await withEnv({ HOME: home }, async () => {
      expect(await gemini.scan()).toEqual([]);
    });
  });

  it("reads Gemini session JSON", async () => {
    const path = await writeGeminiFixture();
    const r = await gemini.read(entry(path));
    expect(r.messages.length).toBe(3);
    expect(r.messages[0]!.role).toBe("user");
    expect(r.messages[0]!.text).toBe("build a parser");
    expect(r.messages[1]!.role).toBe("assistant");
    expect(r.messages[1]!.text).toContain("Plan: Inspect files");
    expect(r.messages[1]!.toolCalls?.[0]?.name).toBe("read_file");
    expect(r.messages[1]!.toolCalls?.[1]?.output).toBe("ok");
    expect(r.messages[2]!.role).toBe("system");
  });

  it("cursor diff returns only new messages by message index", async () => {
    const path = await writeGeminiFixture();
    const r1 = await gemini.read(entry(path));
    const raw = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8")));
    raw.messages.push({
      id: "m4",
      timestamp: "2026-01-01T00:00:03Z",
      type: "user",
      content: "second",
    });
    await writeFile(path, JSON.stringify(raw), "utf8");
    const r2 = await gemini.read(entry(path), r1.nextCursor);
    expect(r2.messages.length).toBe(1);
    expect(r2.messages[0]!.text).toBe("second");
  });

  it("rejects cursor from another adapter", async () => {
    const path = await writeGeminiFixture();
    const bad = encodeCursor({ adapter: "codex", byteOffset: 0, msgIndex: 0 });
    await expect(gemini.read(entry(path), bad)).rejects.toThrow();
  });

  it("passes adapter conformance suite", async () => {
    const path = await writeGeminiFixture();
    await runAdapterConformance(gemini, {
      name: "gemini",
      entry: entry(path),
      expectMinMessages: 3,
    });
  });

  it("scan picks up sessions and cwd metadata under fake $HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "gm-home-"));
    const projectDir = join(home, ".gemini", "tmp", "proj-a");
    const chatsDir = join(projectDir, "chats");
    await mkdir(chatsDir, { recursive: true });
    await writeFile(join(projectDir, ".project_root"), "/tmp/repo\n", "utf8");
    const tx = join(chatsDir, "session-2026-04-29.json");
    await writeFile(tx, JSON.stringify({ sessionId: "gem-1", messages: [] }), "utf8");

    await withEnv({ HOME: home }, async () => {
      const sessions = await gemini.scan();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.id).toBe("gemini:gem-1");
      expect(sessions[0]!.cwd).toBe("/tmp/repo");
      expect(sessions[0]!.transcriptPath).toBe(tx);
    });
  });

  it("parseMessage ignores unknown message types", () => {
    expect(parseMessage({ type: "unknown", content: "x" })).toBeUndefined();
  });
});

async function writeGeminiFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gm-fixture-"));
  const path = join(dir, "session.json");
  await writeFile(path, JSON.stringify({
    sessionId: "gem-session",
    messages: [
      {
        id: "m1",
        timestamp: "2026-01-01T00:00:00Z",
        type: "user",
        content: [{ text: "build a parser" }],
      },
      {
        id: "m2",
        timestamp: "2026-01-01T00:00:01Z",
        type: "gemini",
        thoughts: [{ subject: "Plan", description: "Inspect files" }],
        content: "I will check the format.",
        toolCalls: [{
          id: "tc1",
          name: "read_file",
          args: { path: "a.ts" },
          result: [{ functionResponse: { id: "tc1", response: { output: "ok" } } }],
        }],
      },
      {
        id: "m3",
        timestamp: "2026-01-01T00:00:02Z",
        type: "info",
        content: "loaded context",
      },
    ],
  }), "utf8");
  return path;
}

