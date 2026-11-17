// test/app/paths-routing.test.ts
//
// #20's per-call path resolution (`src/core/tool-paths.ts`, `src/core/repo-path.ts`) and
// the Codex code-mode `exec` reader (`src/adapters/codex/code-mode.ts`) reach every front
// end through the app services: adapters come from the app-layer loader, and `check`
// and the handoff run through `CoordinationService` and `SessionsService`. These cases
// drive the real built-in adapters from a temp home, so a service that bypassed either
// would show the decoy or lose the code-mode edit.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp, type App } from "../../src/app/index.js";
import { makeTmpHome, withEnv } from "../helpers/tmp-home.js";

const CODEX_ID = "019d0000-0000-7000-8000-00000000c0de";

let home: string;
let cleanup: () => Promise<void>;
let ws: string;

beforeEach(async () => {
  ({ home, cleanup } = await makeTmpHome());
  ws = join(home, "ws");
  await mkdir(join(ws, ".git"), { recursive: true });
  for (const file of ["apps/server/src/apps/service.ts", "src/apps/service.ts", "apps/server/src/mcp/tools.ts", "src/mcp/tools.ts", "docs/notes.md"]) {
    await mkdir(join(ws, file, ".."), { recursive: true });
    await writeFile(join(ws, file), "old\n", "utf8");
  }
});

afterEach(async () => {
  await cleanup();
});

/** Every adapter root under the temp home, so only these fixtures are discovered. */
function inTmpHome<T>(fn: (app: App) => Promise<T>): Promise<T> {
  return withEnv(
    { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), XDG_DATA_HOME: join(home, ".local/share"), OPENCODE_DB: "" },
    async () => fn(await createApp({ home, withExternal: false })),
  );
}

async function writeClaudeSession(command: string): Promise<void> {
  const dir = join(home, ".claude", "projects", "-ws");
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(join(dir, "e1.jsonl"), [
    JSON.stringify({ type: "user", sessionId: "e1", cwd: ws, timestamp: now, message: { role: "user", content: "rename createApp in the server" } }),
    JSON.stringify({ type: "assistant", sessionId: "e1", cwd: ws, timestamp: now, message: { role: "assistant", content: [
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command } },
    ] } }),
  ].join("\n") + "\n", "utf8");
}

async function writeCodexCodeModeRollout(): Promise<void> {
  const dir = join(home, ".codex", "sessions", "2026", "11", "13");
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  const exec = (input: string, callId: string) => ({
    type: "response_item", timestamp,
    payload: { type: "custom_tool_call", name: "exec", call_id: callId, input },
  });
  const records = [
    { type: "session_meta", timestamp, payload: { id: CODEX_ID, cwd: ws } },
    { type: "response_item", timestamp, payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Rename the tool." }] } },
    exec(`text(await tools.exec_command({cmd: "sed -i 's/a/b/' src/mcp/tools.ts", workdir: ${JSON.stringify(join(ws, "apps/server"))}}));`, "call_a"),
    { type: "response_item", timestamp, payload: { type: "custom_tool_call_output", call_id: "call_a", output: [{ type: "text", text: "" }] } },
    exec("text(await tools.exec_command({cmd: 'cat docs/notes.md'}));", "call_b"),
  ];
  await writeFile(join(dir, `rollout-2026-11-13T00-00-00-${CODEX_ID}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

describe("#20 path resolution through the app services", () => {
  it("CoordinationService.check resolves a cd-prefixed edit to the real file, not a same-named decoy", async () => {
    await writeClaudeSession("cd apps/server && sed -i 's/old/new/' src/apps/service.ts");
    await inTmpHome(async (app) => {
      const identity = { ignoredSessions: [] };
      const real = await app.coordination.check({ cwd: ws, targets: [join(ws, "apps/server/src/apps/service.ts")], identity, adapter: "claude-code" });
      expect(real.ok).toBe(false);
      expect(real.files[0]!.conflicts.map((conflict) => conflict.id)).toEqual(["claude-code:e1"]);

      const decoy = await app.coordination.check({ cwd: ws, targets: [join(ws, "src/apps/service.ts")], identity, adapter: "claude-code" });
      expect(decoy).toEqual({ ok: true, files: [{ file: join(ws, "src/apps/service.ts"), conflicts: [] }], conflictCount: 0 });
    });
  });

  it("the Codex code-mode reader feeds check and the handoff's file roles through the app-layer loader", async () => {
    await writeCodexCodeModeRollout();
    await inTmpHome(async (app) => {
      const identity = { ignoredSessions: [] };
      const real = await app.coordination.check({ cwd: ws, targets: [join(ws, "apps/server/src/mcp/tools.ts")], identity, adapter: "codex" });
      expect(real.files[0]!.conflicts.map((conflict) => conflict.id)).toEqual([`codex:${CODEX_ID}`]);
      const decoy = await app.coordination.check({ cwd: ws, targets: [join(ws, "src/mcp/tools.ts")], identity, adapter: "codex" });
      expect(decoy.ok).toBe(true);

      const handoff = await app.sessions.peek(`codex:${CODEX_ID}`, { mode: "handoff", produce: "local" });
      const document = (handoff.snapshot as { document: string }).document;
      const files = document.slice(document.indexOf("## Files"));
      expect(files).toContain("- apps/server/src/mcp/tools.ts (modified)");
      expect(files).toContain("Also read: docs/notes.md");
      expect(files).not.toContain("- src/mcp/tools.ts");
    });
  });
});
