// test/adapters/tmux.test.ts
import { describe, it, expect } from "vitest";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import tmux from "../../src/adapters/tmux/index.js";
import type { SessionEntry } from "../../src/core/types.js";
import { encodeCursor } from "../../src/core/cursor.js";
import { runAdapterConformance } from "../helpers/adapter-conformance.js";
import { withEnv } from "../helpers/tmp-home.js";

const entry = (name = "agent:one"): SessionEntry => ({
  id: `tmux:${encodeURIComponent(name)}`,
  adapter: "tmux",
  transcriptPath: `tmux://${encodeURIComponent(name)}`,
  lastSeen: new Date().toISOString(),
  status: "active",
});

describe("tmux adapter", () => {
  it("scan returns tmux sessions", async () => {
    await withFakeTmux(async (env) => {
      const sessions = await tmux.scan();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.id).toBe(`tmux:${encodeURIComponent(env.name)}`);
      expect(sessions[0]!.transcriptPath).toBe(`tmux://${encodeURIComponent(env.name)}`);
      expect(sessions[0]!.status).toBe("active");
    });
  });

  it("captures pane output and advances by captured line", async () => {
    await withFakeTmux(async (env) => {
      process.env.TMUX_FAKE_CAPTURE = "line one\nline two\n";
      const r1 = await tmux.read(entry(env.name));
      expect(r1.messages.length).toBe(1);
      expect(r1.messages[0]!.role).toBe("system");
      expect(r1.messages[0]!.text).toBe("line one\nline two");

      process.env.TMUX_FAKE_CAPTURE = "line one\nline two\nline three\n";
      const r2 = await tmux.read(entry(env.name), r1.nextCursor);
      expect(r2.messages.length).toBe(1);
      expect(r2.messages[0]!.text).toBe("line three");
    });
  });

  it("rejects cursor from another adapter", async () => {
    await withFakeTmux(async (env) => {
      const bad = encodeCursor({ adapter: "codex", byteOffset: 0, msgIndex: 0 });
      await expect(tmux.read(entry(env.name), bad)).rejects.toThrow();
    });
  });

  it("passes adapter conformance suite", async () => {
    await withFakeTmux(async (env) => {
      process.env.TMUX_FAKE_CAPTURE = "a\nb\n";
      await runAdapterConformance(tmux, {
        name: "tmux",
        entry: entry(env.name),
        expectMinMessages: 1,
      });
    });
  });
});

async function withFakeTmux<T>(fn: (env: { name: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "tmux-fake-"));
  const binDir = join(dir, "bin");
  await mkdir(binDir);
  const script = join(binDir, "tmux");
  await writeFile(script, `#!/bin/sh
if [ "$1" = "list-sessions" ]; then
  printf '%s\\t%s\\t%s\\n' "$TMUX_FAKE_NAME" "$TMUX_FAKE_ACTIVITY" "$TMUX_FAKE_ATTACHED"
  exit 0
fi
if [ "$1" = "capture-pane" ]; then
  printf '%s' "$TMUX_FAKE_CAPTURE"
  exit 0
fi
exit 1
`, "utf8");
  await chmod(script, 0o755);
  const nowSeconds = Math.floor(Date.now() / 1000).toString();
  return withEnv({
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMUX_FAKE_NAME: "agent:one",
    TMUX_FAKE_ACTIVITY: nowSeconds,
    TMUX_FAKE_ATTACHED: "1",
    TMUX_FAKE_CAPTURE: "line one\nline two\n",
  }, () => fn({ name: "agent:one" }));
}

