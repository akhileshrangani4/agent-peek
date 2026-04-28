// test/adapters/codex.test.ts
import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, appendFile, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import codex from "../../src/adapters/codex/index.js";
import type { SessionEntry } from "../../src/core/types.js";
import { encodeCursor } from "../../src/core/cursor.js";
import { runAdapterConformance } from "../helpers/adapter-conformance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(__dirname, "../fixtures/codex", name, "transcript.jsonl");

const entry = (path: string, id = "codex:test"): SessionEntry => ({
  id,
  adapter: "codex",
  transcriptPath: path,
  lastSeen: new Date().toISOString(),
  status: "active",
});

describe("codex adapter", () => {
  it("scan finds nothing under empty $HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "co-empty-"));
    process.env.HOME = home;
    const sessions = await codex.scan();
    expect(sessions).toEqual([]);
  });

  it("reads multi-turn fixture", async () => {
    const r = await codex.read(entry(fixture("multi-turn")));
    // 6 records: session_meta + user + assistant + function_call + function_call_output + assistant
    expect(r.messages.length).toBe(6);
    // session_meta becomes a system passthrough
    expect(r.messages[0]!.role).toBe("system");
    expect(r.messages[1]!.role).toBe("user");
    expect(r.messages[1]!.text).toBe("refactor auth");
    expect(r.messages[2]!.role).toBe("assistant");
    expect(r.messages[2]!.text).toBe("Looking at the auth module.");
    // function_call -> assistant with toolCalls
    expect(r.messages[3]!.role).toBe("assistant");
    expect(r.messages[3]!.toolCalls?.[0]?.name).toBe("exec_command");
    expect((r.messages[3]!.toolCalls?.[0]?.input as { cmd?: string })?.cmd).toBe("cat auth.ts");
    // function_call_output -> tool with result
    expect(r.messages[4]!.role).toBe("tool");
    expect(r.messages[4]!.toolCalls?.[0]?.output).toBe("export function login(){}");
    expect(r.messages[5]!.role).toBe("assistant");
    expect(r.eof).toBe(true);
  });

  it("returns empty for empty fixture", async () => {
    const r = await codex.read(entry(fixture("empty")));
    expect(r.messages.length).toBe(0);
  });

  it("ignores corrupt trailing line (writer in flight)", async () => {
    // 3 complete records + 1 truncated (no trailing \n).
    const r = await codex.read(entry(fixture("corrupt-tail")));
    expect(r.messages.length).toBe(3);
  });

  it("cursor diff returns only new messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "co-cursor-"));
    const path = join(dir, "rollout.jsonl");
    await writeFile(path,
      `{"timestamp":"2026-01-01T00:00:00Z","type":"session_meta","payload":{"id":"x","cwd":"/tmp"}}\n`
      + `{"timestamp":"2026-01-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"first"}]}}\n`
      + `{"timestamp":"2026-01-01T00:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}\n`,
      "utf8");
    const r1 = await codex.read(entry(path));
    expect(r1.messages.length).toBe(3);

    await appendFile(path,
      `{"timestamp":"2026-01-01T00:00:03Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"second"}]}}\n`,
      "utf8");

    const r2 = await codex.read(entry(path), r1.nextCursor);
    expect(r2.messages.length).toBe(1);
    expect(r2.messages[0]!.text).toBe("second");
  });

  it("rejects cursor from another adapter", async () => {
    const bad = encodeCursor({ adapter: "claude-code", byteOffset: 0, msgIndex: 0 });
    await expect(codex.read(entry(fixture("multi-turn")), bad)).rejects.toThrow();
  });

  it("passes adapter conformance suite (multi-turn)", async () => {
    await runAdapterConformance(codex, {
      name: "multi-turn",
      entry: entry(fixture("multi-turn")),
      expectMinMessages: 5,
    });
  });

  it("scan picks up sessions under fake $HOME", async () => {
    const home = await mkdtemp(join(tmpdir(), "co-home-"));
    const dayDir = join(home, ".codex", "sessions", "2026", "04", "28");
    await mkdir(dayDir, { recursive: true });
    const sessUuid = "019cbabb-1261-7393-8ae4-007653e6c643";
    const tx = join(dayDir, `rollout-2026-04-28T12-00-00-${sessUuid}.jsonl`);
    await writeFile(tx,
      `{"timestamp":"2026-04-28T12:00:00.000Z","type":"session_meta","payload":{"id":"${sessUuid}","cwd":"/tmp/repo","originator":"Codex"}}\n`
      + `{"timestamp":"2026-04-28T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}\n`,
      "utf8");
    process.env.HOME = home;
    const sessions = await codex.scan();
    expect(sessions.length).toBe(1);
    expect(sessions[0]!.id).toBe(`codex:${sessUuid}`);
    expect(sessions[0]!.cwd).toBe("/tmp/repo");
    expect(sessions[0]!.transcriptPath).toBe(tx);
  });
});
