// test/integration/cli.test.ts
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
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

  it("help command prints focused agent help", async () => {
    const overview = await runCli(["help"]);
    expect(overview.code).toBe(0);
    expect(overview.stdout).toMatch(/Common commands:/);
    expect(overview.stdout).toMatch(/peek coord \. --writing/);

    const coord = await runCli(["help", "coord"]);
    expect(coord.code).toBe(0);
    expect(coord.stdout).toMatch(/peek coord/);
    expect(coord.stdout).toMatch(/Full options: peek coord --help/);
  });

  it("version command prints installed version", async () => {
    const text = await runCli(["version"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^agent-peek \d+\.\d+\.\d+/);

    const json = await runCli(["version", "--json"]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).name).toBe("agent-peek");
  });

  it("update command reports npm status", async () => {
    const current = await runCli(["update", "--check"], { AGENT_PEEK_LATEST_VERSION: "0.0.0" });
    expect(current.code).toBe(0);
    expect(current.stdout).toMatch(/status up-to-date/);

    const newer = await runCli(["update", "--check", "--json"], { AGENT_PEEK_LATEST_VERSION: "9.9.9" });
    expect(newer.code).toBe(0);
    const info = JSON.parse(newer.stdout);
    expect(info.status).toBe("update-available");
    expect(info.command).toBe("npm install -g agent-peek@latest");
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

  it("rejects invalid cursors with agent-friendly diagnostics", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-cursor");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "cursor.jsonl"),
      `{"type":"user","sessionId":"cursor","cwd":"/tmp/cursor","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n`,
      "utf8");
    const badCoord = await runCli(["coord", ".", "--since", "not-a-cursor"], { HOME: home });
    expect(badCoord.code).toBe(5);
    expect(badCoord.stderr).toMatch(/error: invalid_cursor/);

    const badPeek = await runCli(["at", "cursor-claude", "--since", "not-a-cursor"], { HOME: home });
    expect(badPeek.code).toBe(5);
    expect(badPeek.stderr).toMatch(/error: invalid_cursor/);

    const wrongAdapterCursor = Buffer.from(JSON.stringify({
      adapter: "codex",
      byteOffset: 0,
      msgIndex: 0,
    }), "utf8").toString("base64url");
    const mismatch = await runCli(["at", "cursor-claude", "--since", wrongAdapterCursor], { HOME: home });
    expect(mismatch.code).toBe(5);
    expect(mismatch.stderr).toMatch(/error: invalid_cursor/);
    expect(mismatch.stderr).toMatch(/Cursor was issued by adapter/);
  });

  it("at supports brief mode and raw pagination flags", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-page");
    await mkdir(projDir, { recursive: true });
    const tx = join(projDir, "page.jsonl");
    await writeFile(tx, [
      `{"type":"user","sessionId":"page","cwd":"/tmp/page","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"first"}}`,
      `{"type":"assistant","sessionId":"page","cwd":"/tmp/page","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":"second"}}`,
      `{"type":"user","sessionId":"page","cwd":"/tmp/page","timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":"third"}}`,
    ].join("\n") + "\n", "utf8");

    const brief = await runCli(["at", "page-claude", "--mode", "brief"], { HOME: home });
    expect(brief.code).toBe(0);
    expect(brief.stdout).toMatch(/Task: third/);

    const handoff = await runCli(["at", "page-claude", "--mode", "handoff"], { HOME: home });
    expect(handoff.code).toBe(0);
    expect(handoff.stdout).toMatch(/session: claude-code:page/);
    expect(handoff.stdout).toMatch(/activity:/);

    const first = await runCli(["at", "page-claude", "--first", "1"], { HOME: home });
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/messages: 1-1 of 3/);
    expect(first.stdout).toMatch(/first/);
    expect(first.stdout).not.toMatch(/third/);

    const newest = await runCli(["at", "page-claude", "--last", "2", "--reverse"], { HOME: home });
    expect(newest.code).toBe(0);
    expect(newest.stdout.indexOf("third")).toBeLessThan(newest.stdout.indexOf("second"));
  });

  it("coord summarizes sessions for a cwd and returns a reusable cursor", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-coord");
    await mkdir(projDir, { recursive: true });
    const tx = join(projDir, "coord.jsonl");
    await writeFile(tx, [
      `{"type":"user","sessionId":"coord","cwd":"/tmp/coord","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"edit engine"}}`,
      `{"type":"assistant","sessionId":"coord","cwd":"/tmp/coord","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"path":"src/core/engine.ts"}}]}}`,
    ].join("\n") + "\n", "utf8");
    await writeFile(join(projDir, "noise.jsonl"), [
      `{"type":"user","sessionId":"noise","cwd":"/tmp/coord","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"Say ok"}}`,
      `{"type":"assistant","sessionId":"noise","cwd":"/tmp/coord","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":"ok"}}`,
    ].join("\n") + "\n", "utf8");

    const human = await runCli(["coord", "/tmp/coord"], { HOME: home });
    expect(human.code).toBe(0);
    expect(human.stdout).toMatch(/coordination: 1\/2 sessions shown, first snapshot, 1 new/);
    expect(human.stdout).toMatch(/hidden low-signal: 1 sessions/);
    expect(human.stdout).toMatch(/sessions:/);
    expect(human.stdout).toMatch(/coord-claude/);
    expect(human.stdout).not.toMatch(/noise-claude/);
    expect(human.stdout).toMatch(/coord-claude.*reading/);
    expect(human.stdout).toMatch(/hot files: .*src\/core\/engine.ts/);
    expect(human.stdout).not.toMatch(/known files:/);
    expect(human.stdout).not.toMatch(/nextCursor:/);

    const verboseCursor = await runCli(["coord", "/tmp/coord", "--verbose"], { HOME: home });
    expect(verboseCursor.code).toBe(0);
    expect(verboseCursor.stdout).toMatch(/nextCursor:/);

    const json = await runCli(["coord", "/tmp/coord", "--json"], { HOME: home });
    expect(json.code).toBe(0);
    const digest = JSON.parse(json.stdout);
    expect(digest.mode).toBe("coordination");
    expect(digest.firstSnapshot).toBe(true);
    expect(digest.newSessionCount).toBe(1);
    expect(digest.changedSessionCount).toBe(0);
    expect(digest.hiddenSessionCount).toBe(1);
    expect(digest.hiddenLowSignalSessionCount).toBe(1);
    expect(digest.sessions[0].displayName).toBe("coord-claude");
    expect(digest.sessions[0].intent).toBe("reading");
    expect(digest.sessions[0].recentFiles).toEqual(["/tmp/coord/src/core/engine.ts"]);
    expect(digest.sessions[0].knownFiles).toEqual(["/tmp/coord/src/core/engine.ts"]);
    expect(digest.sessions[0].hotFiles).toEqual(["/tmp/coord/src/core/engine.ts"]);

    const all = await runCli(["coord", "/tmp/coord", "--all", "--json"], { HOME: home });
    expect(all.code).toBe(0);
    expect(JSON.parse(all.stdout).sessionCount).toBe(2);

    const next = await runCli(["coord", "/tmp/coord", "--since", digest.nextCursor, "--json"], { HOME: home });
    expect(next.code).toBe(0);
    const nextDigest = JSON.parse(next.stdout);
    expect(nextDigest.firstSnapshot).toBe(false);
    expect(nextDigest.changedSessionCount).toBe(0);
    expect(nextDigest.sessions).toEqual([]);
    expect(nextDigest.hiddenUnchangedSessionCount).toBe(1);

    const verbose = await runCli(["coord", "/tmp/coord", "--since", digest.nextCursor, "--verbose"], { HOME: home });
    expect(verbose.code).toBe(0);
    expect(verbose.stdout).toMatch(/hidden unchanged: 1 sessions/);

    const cursorFile = join(home, "coord.cursor");
    const projected = await runCli([
      "coord", "/tmp/coord", "--json",
      "--fields", "currentTask,intent,writingFiles",
      "--cursor-file", cursorFile,
    ], { HOME: home });
    expect(projected.code).toBe(0);
    const projectedDigest = JSON.parse(projected.stdout);
    expect(projectedDigest.nextCursor).toBeUndefined();
    expect(projectedDigest.cursorFile).toBe(cursorFile);
    expect(projectedDigest.sessions[0]).toEqual({
      id: "claude-code:coord",
      displayName: "coord-claude",
      adapter: "claude-code",
      status: "active",
      lastSeen: expect.any(String),
      currentTask: "edit engine",
      intent: "reading",
      writingFiles: [],
    });
    expect((await readFile(cursorFile, "utf8")).trim()).toMatch(/^gz\./);

    const sinceFile = await runCli([
      "coord", "/tmp/coord", "--json",
      "--since-file", cursorFile,
      "--fields", "currentTask,intent,writingFiles",
    ], { HOME: home });
    expect(sinceFile.code).toBe(0);
    const sinceFileDigest = JSON.parse(sinceFile.stdout);
    expect(sinceFileDigest.firstSnapshot).toBe(false);
    expect(sinceFileDigest.nextCursor).toBeUndefined();
    expect(sinceFileDigest.cursorFile).toBe(cursorFile);
    expect((await readFile(cursorFile, "utf8")).trim()).toMatch(/^gz\./);

    const writingOnly = await runCli(["coord", "/tmp/coord", "--writing", "--json"], { HOME: home });
    expect(writingOnly.code).toBe(0);
    expect(JSON.parse(writingOnly.stdout).sessionCount).toBe(0);
  });

  it("check exits 1 for active writing conflicts and list --files shows file context", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-check");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "check.jsonl"), [
      `{"type":"user","sessionId":"check","cwd":"/tmp/check","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"edit engine"}}`,
      `{"type":"assistant","sessionId":"check","cwd":"/tmp/check","timestamp":"${new Date().toISOString()}","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"path":"src/core/engine.ts"}}]}}`,
    ].join("\n") + "\n", "utf8");

    const conflict = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/check"], { HOME: home });
    expect(conflict.code).toBe(1);
    expect(conflict.stdout).toMatch(/conflict:/);
    expect(conflict.stdout).toMatch(/check-claude/);

    const ok = await runCli(["check", "README.md", "--cwd", "/tmp/check"], { HOME: home });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/ok: no active writing conflict/);

    const files = await runCli(["list", "--files", "--adapter", "claude-code"], { HOME: home });
    expect(files.code).toBe(0);
    expect(files.stdout).toMatch(/FILES/);
    expect(files.stdout).toMatch(/writing: .*src\/core\/engine.ts/);
  });

  it("claim adds temporary file ownership that check and coord can see", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const claimFiles = join(home, "claim-files.txt");
    await writeFile(claimFiles, "README.md\n", "utf8");
    const claim = await runCli([
      "claim", "src/core/engine.ts",
      "--files-from", claimFiles,
      "--cwd", "/tmp/claim",
      "--as", "tester",
      "--ttl", "2m",
      "--json",
    ], { HOME: home });
    expect(claim.code).toBe(0);
    const claimed = JSON.parse(claim.stdout);
    expect(claimed.owner).toBe("tester");
    expect(claimed.files).toEqual(["/tmp/claim/README.md", "/tmp/claim/src/core/engine.ts"]);

    const conflict = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/claim", "--json"], { HOME: home });
    expect(conflict.code).toBe(1);
    const check = JSON.parse(conflict.stdout);
    expect(check.ok).toBe(false);
    expect(check.conflicts).toBeUndefined();
    expect(check.files[0].conflicts[0].displayName).toBe("claim-tester");

    const selfCheck = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/claim", "--as", "tester", "--json"], { HOME: home });
    expect(selfCheck.code).toBe(0);
    expect(JSON.parse(selfCheck.stdout).ok).toBe(true);

    const filesList = join(home, "files.txt");
    await writeFile(filesList, "README.md\nsrc/other.ts\n", "utf8");
    const bulk = await runCli(["check", "--files-from", filesList, "--cwd", "/tmp/claim", "--json"], { HOME: home });
    expect(bulk.code).toBe(1);
    expect(JSON.parse(bulk.stdout).conflictCount).toBe(1);

    const coord = await runCli(["coord", "/tmp/claim", "--writing", "--json"], { HOME: home });
    expect(coord.code).toBe(0);
    expect(JSON.parse(coord.stdout).sessions[0].displayName).toBe("claim-tester");

    const partialFile = join(home, "release-files.txt");
    await writeFile(partialFile, "README.md\n", "utf8");
    const partialRelease = await runCli(["release", claimed.id, "--claim-id", "--files-from", partialFile, "--cwd", "/tmp/claim", "--json"], { HOME: home });
    expect(partialRelease.code).toBe(0);
    const partial = JSON.parse(partialRelease.stdout);
    expect(partial.files).toEqual(["/tmp/claim/README.md"]);

    const stillClaimed = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/claim", "--json"], { HOME: home });
    expect(stillClaimed.code).toBe(1);
    expect(JSON.parse(stillClaimed.stdout).conflictCount).toBe(1);

    const release = await runCli(["release", claimed.id, "--claim-id", "--json"], { HOME: home });
    expect(release.code).toBe(0);
    const released = JSON.parse(release.stdout);
    expect(released.released).toBe(1);
    expect(released.claims[0].id).toBe(claimed.id);
    expect(released.files).toEqual(["/tmp/claim/src/core/engine.ts"]);

    const clear = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/claim"], { HOME: home });
    expect(clear.code).toBe(0);
    expect(clear.stdout).toMatch(/ok: no active writing conflict/);
  });

  it("claim uses CLAUDE_SESSION_ID when present instead of user@host:pid", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["claim", "test-file.ts", "--json"], { HOME: home, CLAUDE_SESSION_ID: "sess-42" });
    expect(r.code).toBe(0);
    const claim = JSON.parse(r.stdout);
    expect(claim.owner).toBe("claude-code:sess-42");
  });

  it("doctor shows adapter availability", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["doctor"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/agent-peek \d+\.\d+\.\d+/);
    expect(r.stdout).toMatch(/ADAPTER/);
    expect(r.stdout).toMatch(/claude-code/);
    expect(r.stdout).toMatch(/tmux/);
    expect(r.stdout).toMatch(/next:/);
  });
});

describe("skills --json segmentation", () => {
  it("labels every skill with its segment and carries per-segment totals", async () => {
    // Without this a consumer cannot reproduce the segmentation that makes the tool
    // safe to act on: the human report says a skill is archivable and the JSON did not
    // say which bucket anything was in, so verifying "no archivable row lacks a mutable
    // installation" from the outside was impossible.
    const r = await runCli(["skills", "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as {
      skills: { segment?: string; installations: { mutable: boolean }[] }[];
      segments: { id: string; count: number; tokens: number }[];
    };
    expect(Array.isArray(doc.segments)).toBe(true);
    expect(doc.segments.map((s) => s.id)).toContain("archivable");
    expect(doc.skills.every((s) => typeof s.segment === "string")).toBe(true);

    // The assertion this field exists to make checkable from outside.
    const archivable = doc.skills.filter((s) => s.segment === "archivable");
    expect(archivable.every((s) => s.installations.some((i) => i.mutable))).toBe(true);

    // The summary must agree with the rows it summarises.
    const counted = doc.segments.find((s) => s.id === "archivable")!.count;
    expect(counted).toBe(archivable.length);
  }, 120_000);
});

describe("presentation invariants (ticket 15)", () => {
  const commands = [["agents"], ["agents", "--all"], ["list"], ["doctor"]];
  const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

  it("degrades to 80 columns without truncating past it", async () => {
    // 80 is the floor to degrade to, not the target: a reader on a 120-column terminal
    // should get the width they have. This pins the narrow end.
    for (const argv of commands) {
      const out = await runCli(argv, { COLUMNS: "80" });
      for (const line of out.stdout.split("\n")) {
        // Characters, not bytes: an elided path carries a multi-byte ellipsis, and a
        // byte count would condemn a line that fits.
        expect([...line.replace(ANSI, "")].length, `${argv.join(" ")}: ${line}`)
          .toBeLessThanOrEqual(80);
      }
    }
  }, 60000);

  it("emits no escape codes when stdout is not a TTY", async () => {
    // Piping into grep and awk is how several verification steps in this effort work; a
    // colour code landing mid-token breaks them silently.
    for (const argv of commands) {
      const out = await runCli(argv);
      expect(out.stdout.includes(String.fromCharCode(27)), argv.join(" ")).toBe(false);
    }
  }, 60000);

  it("keeps every presence state distinguishable without colour", async () => {
    // The four states are the substance of the agent model. If styling ever carries that
    // distinction alone, it vanishes in monochrome and in a pipe.
    const out = await runCli(["agents", "--all"]);
    const states = new Set<string>();
    for (const line of out.stdout.split("\n")) {
      const match = line.match(/^\S+\s+(present|unconfirmed|absent|no-convention)\b/);
      if (match) states.add(match[1]!);
    }
    expect(states.size).toBeGreaterThanOrEqual(3);
    expect(states.has("unconfirmed")).toBe(true);
  }, 60000);
});
