// test/integration/concurrent-write.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claudeCode from "../../src/adapters/claude-code/index.js";

describe("concurrent transcript write", () => {
  it("never throws and never returns partial JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ap-conc-"));
    const path = join(dir, "t.jsonl");
    await writeFile(path, "", "utf8");

    let stop = false;
    const writer = (async () => {
      for (let i = 0; i < 200; i++) {
        const line = JSON.stringify({
          type: "user",
          sessionId: "x",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: `msg ${i}` },
        }) + "\n";
        await appendFile(path, line.slice(0, 10), "utf8");
        await new Promise((r) => setTimeout(r, 1));
        await appendFile(path, line.slice(10), "utf8");
        if (stop) break;
      }
    })();

    const reader = (async () => {
      let cursor: string | undefined;
      let total = 0;
      for (let i = 0; i < 50; i++) {
        const r = await claudeCode.read(
          { id: "claude-code:x", adapter: "claude-code", transcriptPath: path,
            lastSeen: "", status: "active" },
          cursor,
        );
        for (const m of r.messages) {
          expect(m.text).toMatch(/^msg \d+$/);
        }
        total += r.messages.length;
        cursor = r.nextCursor;
        await new Promise((r) => setTimeout(r, 5));
      }
      return total;
    })();

    const total = await reader;
    stop = true;
    await writer;
    expect(total).toBeGreaterThan(0);
  }, 10_000);
});
