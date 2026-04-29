// test/integration/cli.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../../bin/peek.js");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn("node", [BIN, ...args], { env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => res({ code: code ?? 0, stdout: out, stderr: err }));
  });
}

describe("CLI integration", () => {
  it("--help prints usage", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.stdout).toMatch(/Examples:/);
    expect(r.stderr).toBe("");
  });

  it("ui help is available", async () => {
    const r = await runCli(["ui", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage:/);
    expect(r.stdout).toMatch(/peek ui --adapter codex/);
    expect(r.stdout).toMatch(/--terminals/);
    expect(r.stderr).toBe("");
  });

  it("ui requires an interactive terminal", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["ui"], { HOME: home });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/error: ui_requires_tty/);
    expect(r.stderr).toMatch(/peek list/);
  });

  it("unknown command exits with agent-friendly diagnostic", async () => {
    const r = await runCli(["nope"]);
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/error: unknown_command/);
    expect(r.stderr).toMatch(/next:/);
  });

  it("list returns (no sessions) under empty fake home", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["list"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no sessions/);
  });

  it("peek of unknown selector exits 2 with helpful message", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["at", "ghost"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/error: session_not_found/);
    expect(r.stderr).toMatch(/peek list/);
  });

  it("list discovers a fake claude-code session", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-x");
    await mkdir(projDir, { recursive: true });
    const tx = join(projDir, "abc.jsonl");
    await writeFile(tx,
      `{"type":"user","sessionId":"abc","cwd":"/tmp/x","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n`,
      "utf8");
    const r = await runCli(["list"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/x-claude/);
    expect(r.stdout).not.toMatch(/claude-code:abc/);

    const withIds = await runCli(["list", "--ids"], { HOME: home });
    expect(withIds.code).toBe(0);
    expect(withIds.stdout).toMatch(/claude-code:abc/);
  });

  it("list hides ended sessions unless --all or --status is used", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-old");
    await mkdir(projDir, { recursive: true });
    const tx = join(projDir, "old.jsonl");
    await writeFile(tx,
      `{"type":"user","sessionId":"old","cwd":"/tmp/old","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n`,
      "utf8");
    const oldTime = new Date(Date.now() - 48 * 3600 * 1000);
    await utimes(tx, oldTime, oldTime);

    const hidden = await runCli(["list", "--adapter", "claude-code"], { HOME: home });
    expect(hidden.code).toBe(0);
    expect(hidden.stdout).not.toMatch(/claude-code:old/);

    const all = await runCli(["list", "--adapter", "claude-code", "--all"], { HOME: home });
    expect(all.code).toBe(0);
    expect(all.stdout).toMatch(/old-claude/);

    const byStatus = await runCli(["list", "--adapter", "claude-code", "--status", "ended"], { HOME: home });
    expect(byStatus.code).toBe(0);
    expect(byStatus.stdout).toMatch(/old-claude/);
  });

  it("list --json includes displayName", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-json");
    await mkdir(projDir, { recursive: true });
    const tx = join(projDir, "json.jsonl");
    await writeFile(tx,
      `{"type":"user","sessionId":"json","cwd":"/tmp/json","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n`,
      "utf8");
    const r = await runCli(["list", "--json", "--adapter", "claude-code"], { HOME: home });
    expect(r.code).toBe(0);
    const list = JSON.parse(r.stdout);
    expect(list[0].displayName).toBe("json-claude");
  });

  it("list rejects invalid status", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["list", "--status", "busy"], { HOME: home });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/error: invalid_status/);
    expect(r.stderr).toMatch(/Status must be one of/);
  });

  it("at rejects invalid mode and limit with agent-friendly diagnostics", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const badMode = await runCli(["at", "x", "--mode", "busy"], { HOME: home });
    expect(badMode.code).toBe(5);
    expect(badMode.stderr).toMatch(/error: invalid_mode/);

    const badLimit = await runCli(["at", "x", "--limit", "zero"], { HOME: home });
    expect(badLimit.code).toBe(5);
    expect(badLimit.stderr).toMatch(/error: invalid_limit/);
  });

  it("doctor shows adapter availability", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["doctor"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ADAPTER/);
    expect(r.stdout).toMatch(/claude-code/);
    expect(r.stdout).toMatch(/tmux/);
  });
});
