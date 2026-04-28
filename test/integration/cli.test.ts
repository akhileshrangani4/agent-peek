// test/integration/cli.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
    expect(r.stdout).toMatch(/claude-code:abc/);
  });
});
