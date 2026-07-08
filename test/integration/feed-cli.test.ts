// test/integration/feed-cli.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

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

async function makeProject(home: string): Promise<string> {
  const dir = join(home, "proj");
  await mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

describe("peek post / feed / expand", () => {
  const tempRoots: string[] = [];

  afterAll(() => {
    for (const root of tempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("posts a finding and reads it back as JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    const posted = await runCli([
      "post", "finding", "Auth lives in middleware",
      "--text", "verify.ts owns it", "--paths", "src/verify.ts",
      "--as", "tester", "--dir", dir, "--json",
    ], { HOME: home });
    expect(posted.code).toBe(0);
    const post = JSON.parse(posted.stdout);

    const feed = await runCli(["feed", dir, "--no-derived", "--json"], { HOME: home });
    expect(feed.code).toBe(0);
    const result = JSON.parse(feed.stdout);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].post.id).toBe(post.id);
    expect(result.nextCursor).toBeTruthy();
  });

  it("rejects a post without --text with exit code 5", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    const r = await runCli([
      "post", "status", "hello", "--as", "tester", "--dir", dir,
    ], { HOME: home });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/error: post_rejected/);
  });

  it("accepts day-unit TTLs on peek post", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    const r = await runCli([
      "post", "status", "ttl in days", "--text", "x",
      "--as", "tester", "--dir", dir, "--ttl", "2d", "--json",
    ], { HOME: home });
    expect(r.code).toBe(0);
    const post = JSON.parse(r.stdout);
    const lifetimeMs = Date.parse(post.lifecycle.expiresAt) - Date.parse(post.lifecycle.createdAt);
    expect(lifetimeMs).toBe(2 * 24 * 60 * 60 * 1000);
  });

  it("rejects a bare --text flag with no value with exit code 5", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    const r = await runCli([
      "post", "status", "hello", "--as", "tester", "--dir", dir, "--text",
    ], { HOME: home });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/error: (invalid_usage|post_rejected)/);
  });

  it("rejects a repeated --text flag (array coercion) instead of writing a garbled body", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    const r = await runCli([
      "post", "status", "hello", "--text", "--text", "actual body", "--as", "tester", "--dir", dir,
    ], { HOME: home });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/error: post_rejected/);
  });

  it("rejects a pathless finding with exit code 5", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    const r = await runCli([
      "post", "finding", "t", "--text", "x", "--as", "tester", "--dir", dir,
    ], { HOME: home });
    expect(r.code).toBe(5);
    expect(r.stderr).toMatch(/error: post_rejected/);
  });

  it("prints a future-relative expiry instead of '0s ago'", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    const posted = await runCli([
      "post", "status", "hello", "--text", "x", "--as", "tester", "--dir", dir,
    ], { HOME: home });
    expect(posted.code).toBe(0);
    expect(posted.stdout).toMatch(/expires in \d+[smhd]\)/);
    expect(posted.stdout).not.toMatch(/expires 0s ago/);
  });

  it("expand returns the full post; unknown id exits 2", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    const posted = await runCli([
      "post", "status", "hello", "--text", "x", "--as", "tester", "--dir", dir, "--json",
    ], { HOME: home });
    const post = JSON.parse(posted.stdout);

    const expanded = await runCli(["expand", post.id, "--dir", dir, "--json"], { HOME: home });
    expect(expanded.code).toBe(0);
    expect(JSON.parse(expanded.stdout).id).toBe(post.id);

    const missing = await runCli(["expand", "missing-id", "--dir", dir], { HOME: home });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/error: post_not_found/);
  });

  it("handles repeated --mention flags correctly", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    const posted = await runCli([
      "post", "status", "hello", "--text", "notify multiple",
      "--mention", "agent-a", "--mention", "agent-b",
      "--as", "tester", "--dir", dir, "--json",
    ], { HOME: home });
    expect(posted.code).toBe(0);
    const post = JSON.parse(posted.stdout);
    expect(post.links.mentions).toHaveLength(2);
    expect(post.links.mentions).toContain("agent-a");
    expect(post.links.mentions).toContain("agent-b");
  });

  it("feed --stats reports counters", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-feed-cli-"));
    tempRoots.push(home);
    const dir = await makeProject(home);
    await runCli(["post", "status", "hello", "--text", "x", "--as", "tester", "--dir", dir], { HOME: home });
    const stats = await runCli(["feed", dir, "--stats", "--json"], { HOME: home });
    expect(stats.code).toBe(0);
    const parsed = JSON.parse(stats.stdout);
    expect(parsed.posts).toBe(1);
  });
});
