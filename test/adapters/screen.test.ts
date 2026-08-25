// test/adapters/screen.test.ts
import { describe, it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import screen from "../../src/adapters/screen/index.js";
import type { SessionEntry } from "../../src/core/types.js";
import { encodeCursor } from "../../src/core/cursor.js";
import { runAdapterConformance } from "../helpers/adapter-conformance.js";
import { withEnv } from "../helpers/tmp-home.js";

const entry = (name = "1234.agent"): SessionEntry => ({
  id: `screen:${encodeURIComponent(name)}`,
  adapter: "screen",
  transcriptPath: `screen://${encodeURIComponent(name)}`,
  lastSeen: new Date().toISOString(),
  status: "active",
});

describe("screen adapter", () => {
  it("scan returns screen sessions", async () => {
    await withFakeScreen(async (env) => {
      const sessions = await screen.scan();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.id).toBe(`screen:${encodeURIComponent(env.name)}`);
      expect(sessions[0]!.transcriptPath).toBe(`screen://${encodeURIComponent(env.name)}`);
      expect(sessions[0]!.status).toBe("active");
    });
  });

  it("captures hardcopy output and advances by captured line", async () => {
    await withFakeScreen(async (env) => {
      process.env.SCREEN_FAKE_CAPTURE = "line one\nline two\n";
      const r1 = await screen.read(entry(env.name));
      expect(r1.messages.length).toBe(1);
      expect(r1.messages[0]!.role).toBe("system");
      expect(r1.messages[0]!.text).toBe("line one\nline two");

      process.env.SCREEN_FAKE_CAPTURE = "line one\nline two\nline three\n";
      const r2 = await screen.read(entry(env.name), r1.nextCursor);
      expect(r2.messages.length).toBe(1);
      expect(r2.messages[0]!.text).toBe("line three");
    });
  });

  it("rejects cursor from another adapter", async () => {
    await withFakeScreen(async (env) => {
      const bad = encodeCursor({ adapter: "tmux", byteOffset: 0, msgIndex: 0 });
      await expect(screen.read(entry(env.name), bad)).rejects.toThrow();
    });
  });

  it("keeps emitting after scrollback eviction flattens line count", async () => {
    await withFakeScreen(async (env) => {
      process.env.SCREEN_FAKE_CAPTURE = "l1\nl2\nl3\n";
      const r1 = await screen.read(entry(env.name));

      // History cap reached: oldest line evicted as a new one arrives.
      process.env.SCREEN_FAKE_CAPTURE = "l2\nl3\nl4\n";
      const r2 = await screen.read(entry(env.name), r1.nextCursor);
      expect(r2.messages.length).toBe(1);
      expect(r2.messages[0]!.text).toBe("l4");

      // No change at all: empty delta.
      const r3 = await screen.read(entry(env.name), r2.nextCursor);
      expect(r3.messages.length).toBe(0);

      // In-place redraw overwrites the anchor: bounded replay, not data loss.
      process.env.SCREEN_FAKE_CAPTURE = "zz\nl3\nspinner...";
      const r4 = await screen.read(entry(env.name), r2.nextCursor);
      expect(r4.messages.length).toBe(1);
      expect(r4.messages[0]!.text).toContain("spinner...");
    });
  });

  it("passes adapter conformance suite", async () => {
    await withFakeScreen(async (env) => {
      process.env.SCREEN_FAKE_CAPTURE = "a\nb\n";
      await runAdapterConformance(screen, {
        name: "screen",
        entry: entry(env.name),
        expectMinMessages: 1,
      });
    });
  });
});

async function withFakeScreen<T>(fn: (env: { name: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "screen-fake-"));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const script = join(binDir, "screen");
  await writeFile(script, `#!/bin/sh
if [ "$1" = "-ls" ]; then
  printf 'There is a screen on:\\n\\t%s\\t(Attached)\\n1 Socket in /tmp/screens.\\n' "$SCREEN_FAKE_NAME"
  exit 0
fi
if [ "$1" = "-S" ] && [ "$3" = "-X" ] && [ "$4" = "hardcopy" ]; then
  printf '%s' "$SCREEN_FAKE_CAPTURE" > "$6"
  exit 0
fi
exit 1
`, "utf8");
  await chmod(script, 0o755);
  return withEnv({
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    SCREEN_FAKE_NAME: "1234.agent",
    SCREEN_FAKE_CAPTURE: "line one\nline two\n",
  }, () => fn({ name: "1234.agent" }));
}

