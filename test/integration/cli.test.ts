// test/integration/cli.test.ts
import { describe, it, expect , beforeAll} from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertDistFresh } from "../helpers/fresh-dist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../../bin/peek.js");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const childEnv = isolatedHomeEnv(env);
    const p = spawn("node", [BIN, ...args], { env: childEnv });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => res({ code: code ?? 0, stdout: out, stderr: err }));
  });
}

function runCliWithStdin(args: string[], stdin: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const p = spawn("node", [BIN, ...args], { env: isolatedHomeEnv(env) });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => res({ code: code ?? 0, stdout: out, stderr: err }));
    p.stdin.end(stdin);
  });
}

function isolatedHomeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv = { ...process.env, ...env };
  if (env.HOME && env.XDG_DATA_HOME === undefined) delete childEnv.XDG_DATA_HOME;
  return childEnv;
}

beforeAll(() => assertDistFresh());

describe("CLI integration", () => {
  it("bare peek prints the overview and exits 0", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^agent-peek/m);
    expect(r.stdout).toMatch(/Exit codes:/);
    expect(r.stdout).toMatch(/agent-peek-mcp/);
    expect(r.stderr).toBe("");
  });

  it("at <adapter-name> explains that adapters are not sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["at", "claude"], { HOME: home });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/`claude-code` is an adapter \(agent kind\), not a session/);
    expect(r.stderr).toMatch(/peek list --adapter claude-code/);
  });

  it("errors under --json are a JSON record on stdout with the slug line on stderr", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["at", "nosuchsession", "--json"], { HOME: home });
    expect(r.code).toBe(2);
    const record = JSON.parse(r.stdout);
    expect(record.error).toBe("session_not_found");
    expect(record.exit).toBe(2);
    expect(record.next.length).toBeGreaterThan(0);
    expect(r.stderr.trim()).toBe("error: session_not_found · exit 2");
  });

  it("a read-only home is an environment error (exit 6), and doctor says so", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-ro-"));
    await writeFile(join(home, ".agent-peek"), "a file where the state dir should be", "utf8");
    const r = await runCli(["list", "--json"], { HOME: home });
    expect(r.code).toBe(6);
    const record = JSON.parse(r.stdout);
    expect(record.error).toBe("state_unwritable");
    expect(record.message).toMatch(/cannot write its state at .*\.agent-peek/);
    expect(record.hint).toMatch(/read-only sandbox/);
    const doctor = await runCli(["doctor", "--json"], { HOME: home });
    expect(JSON.parse(doctor.stdout).state).toMatchObject({ writable: false });
    const usage = await runCli(["usage", "--json"], { HOME: home });
    expect(usage.code).toBe(6);
    expect(JSON.parse(usage.stdout).error).toBe("state_unwritable");
  });

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
    // "Common commands:" was a single flat list; help is now grouped. Assert that the
    // commands are offered, not the heading they sit under.
    expect(overview.stdout).toMatch(/peek usage/);
    expect(overview.stdout).toMatch(/peek skills/);
    expect(overview.stdout).toMatch(/peek agents/);
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
    // `next:` became a `try` block. What must hold is that the machine-readable slug
    // survives for scripts and that at least one suggested command is offered.
    expect(r.stderr).toMatch(/error: unknown_command/);
    expect(r.stderr).toMatch(/peek help/);
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

  it("list prints a header row and names the flag that reveals cut rows", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-many");
    await mkdir(projDir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      await writeFile(join(projDir, `s${i}.jsonl`), `{"type":"user","sessionId":"s${i}","cwd":"/tmp/many/${i}","timestamp":"${new Date().toISOString()}","message":{"role":"user","content":"hi"}}\n`, "utf8");
    }
    const r = await runCli(["list", "--limit", "2", "--width", "100"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/name\s+adapter\s+updated\s+cwd/);
    // The selector column is never cut; a long name pushes the path column instead.
    const longDir = join(home, ".claude", "projects", "-tmp-a-deliberately-very-long-session-directory-name");
    await mkdir(longDir, { recursive: true });
    await writeFile(join(longDir, "long.jsonl"), `{"type":"user","sessionId":"long","cwd":"/tmp/a-deliberately-very-long-session-directory-name","timestamp":"${new Date().toISOString()}","message":{"role":"user","content":"hi"}}\n`, "utf8");
    const wide = await runCli(["list", "--width", "80"], { HOME: home });
    expect(wide.stdout).toMatch(/a-deliberately-very-long-session-directory-name-claude\s/);
    expect(wide.stdout).not.toMatch(/session-directory-name-cl\S*…/);
    expect(r.stdout).toMatch(/1 more \w+ · peek list --limit 3/);
    expect(r.stdout).not.toMatch(/more \w+ · peek list --all/);
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

    // --local skips the agent CLI: tests must never spawn a real harness.
    const local = await runCli(["at", "page-claude", "--mode", "handoff", "--local"], { HOME: home });
    expect(local.code).toBe(0);
    expect(local.stdout).toMatch(/^> regex handoff \(--local\)/m);
    expect(local.stdout).not.toMatch(/Install claude/);
    expect(local.stdout).toMatch(/^# Handoff$/m);
    expect(local.stdout).toMatch(/## Next actions/);
    expect(local.stdout).not.toMatch(/nextCursor/); // stdout is the document; the cursor goes to stderr
    expect(local.stderr).toMatch(/nextCursor:/);
    expect(local.stderr).toMatch(/local fallback; for generic; 3 messages/);

    // A runner override stands in for the harness. `cat` echoes the prompt back as the document,
    // which also proves the prompt carried the transcript and the target framing.
    const outFile = join(home, "handoff.md");
    const viaRunner = await runCli(
      ["at", "page-claude", "--mode", "handoff", "--for", "chatgpt", "--out", outFile],
      { HOME: home, AGENT_PEEK_HANDOFF_RUNNER: "cat" },
    );
    expect(viaRunner.code).toBe(0);
    expect(viaRunner.stdout).toMatch(/\[user\] first/);
    expect(viaRunner.stdout).toMatch(/\[assistant\] second/);
    expect(viaRunner.stdout).toMatch(/NO filesystem/);
    expect(viaRunner.stderr).toMatch(/written by cat; for chatgpt/);
    expect(viaRunner.stderr).toMatch(/wrote .*handoff\.md/);
    expect((await readFile(outFile, "utf8")).trim()).toBe(viaRunner.stdout.trim());

    const badTarget = await runCli(["at", "page-claude", "--mode", "handoff", "--for", "nope", "--local"], { HOME: home });
    expect(badTarget.code).toBe(5);
    expect(badTarget.stderr).toMatch(/invalid_handoff_target/);

    const first = await runCli(["at", "page-claude", "--first", "1"], { HOME: home });
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/messages: 1-1 of 3/);
    expect(first.stdout).toMatch(/first/);
    expect(first.stdout).not.toMatch(/third/);

    const newest = await runCli(["at", "page-claude", "--last", "2", "--reverse"], { HOME: home });
    expect(newest.code).toBe(0);
    expect(newest.stdout.indexOf("third")).toBeLessThan(newest.stdout.indexOf("second"));

    // --since keeps absolute numbering: message 2 of 3 stays "2", not "1 of 2".
    const lines = (await readFile(tx, "utf8")).split("\n");
    const afterFirst = Buffer.from(JSON.stringify({ adapter: "claude-code", byteOffset: Buffer.byteLength(lines[0]! + "\n"), msgIndex: 1 }), "utf8").toString("base64url");
    const since = await runCli(["at", "page-claude", "--since", afterFirst], { HOME: home });
    expect(since.code).toBe(0);
    expect(since.stdout).toMatch(/messages: 2-3 of 3/);
    expect(since.stdout).not.toMatch(/^\s+first$/m);
    const sinceJson = JSON.parse((await runCli(["at", "page-claude", "--since", afterFirst, "--json"], { HOME: home })).stdout);
    expect(sinceJson.snapshot.window).toEqual({ start: 1, end: 3, order: "oldest-first" });
    expect(sinceJson.snapshot.totalMessageCount).toBe(3);
  });

  it("at says when a raw window is all tool-only messages instead of printing nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-tools");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "tools.jsonl"), [
      `{"type":"user","sessionId":"tools","cwd":"/tmp/tools","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"read it"}}`,
      `{"type":"assistant","sessionId":"tools","cwd":"/tmp/tools","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/tools/a.ts"}}]}}`,
      `{"type":"assistant","sessionId":"tools","cwd":"/tmp/tools","timestamp":"2026-01-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"file_path":"/tmp/tools/b.ts"}}]}}`,
    ].join("\n") + "\n", "utf8");

    // --last 2 means two visible rows: the window widens past the tool-only tail.
    const widened = await runCli(["at", "tools-claude", "--last", "2"], { HOME: home });
    expect(widened.code).toBe(0);
    expect(widened.stdout).toMatch(/messages: 1-3 of 3/);
    expect(widened.stdout).toMatch(/read it/);
    expect(widened.stdout).toMatch(/2 tool-only messages hidden/);
    // With --tools the window is exactly what was asked for.
    const exact = await runCli(["at", "tools-claude", "--last", "2", "--tools"], { HOME: home });
    expect(exact.stdout).toMatch(/messages: 2-3 of 3/);

    const shown = await runCli(["at", "tools-claude", "--last", "2", "--tools"], { HOME: home });
    expect(shown.stdout).toMatch(/tool=Read file_path=\/tmp\/tools\/a\.ts/);
    expect(shown.stdout).not.toMatch(/hidden|0 shown/);

    const mixed = await runCli(["at", "tools-claude", "--last", "3"], { HOME: home });
    expect(mixed.stdout).toMatch(/read it/);
    expect(mixed.stdout).toMatch(/2 tool-only messages hidden/);

    // A cursor at the end reads as an explicit empty result, not an inverted range.
    const first = await runCli(["at", "tools-claude", "--json"], { HOME: home });
    const cursor = JSON.parse(first.stdout).nextCursor;
    const empty = await runCli(["at", "tools-claude", "--since", cursor], { HOME: home });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toMatch(/^No new messages; cursor is at message 3 of 3\./m);
    expect(empty.stdout).not.toMatch(/messages: 4-3/);

    // "." resolves to this directory's session, and an unknown --limit is refused.
    const dot = await runCli(["at", ".", "--mode", "brief"], { HOME: home, PWD: "/tmp/tools" });
    expect(dot.code).toBe(2); // the fixture cwd does not exist on disk, so "." stays literal here
    const badLimit = await runCli(["list", "--limit", "abc"], { HOME: home });
    expect(badLimit.code).toBe(5);
    expect(badLimit.stderr).toMatch(/--limit must be a positive integer, got abc/);
  });

  it("at . resolves the session whose cwd is the current directory", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-cwd");
    await mkdir(projDir, { recursive: true });
    const cwd = process.cwd();
    await writeFile(join(projDir, "here.jsonl"), `{"type":"user","sessionId":"here","cwd":${JSON.stringify(cwd)},"timestamp":"${new Date().toISOString()}","message":{"role":"user","content":"look here"}}\n`, "utf8");
    const r = await runCli(["at", ".", "--mode", "brief"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Task: look here/);
  });

  it("claiming from a directory shared by two live sessions does not impersonate either", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-shared");
    await mkdir(projDir, { recursive: true });
    const cwd = process.cwd();
    for (const id of ["agent-a", "agent-b"]) {
      await writeFile(join(projDir, `${id}.jsonl`), `{"type":"user","sessionId":"${id}","cwd":${JSON.stringify(cwd)},"timestamp":"${new Date().toISOString()}","message":{"role":"user","content":"working"}}\n`, "utf8");
    }
    const r = await runCli(["claim", "shared-probe.ts", "--json"], { HOME: home });
    expect(r.code).toBe(0);
    const claim = JSON.parse(r.stdout);
    expect(claim.owner).not.toMatch(/^claude-code:agent-/);
    expect(claim.identityNote).toMatch(/could not tell which of 2 live sessions in this directory is you/);
    expect(r.stderr).toMatch(/identity: could not tell/);
    await runCli(["release", "shared-probe.ts"], { HOME: home });
  });

  it("ambiguous selectors name the candidate sessions, and bare claim/release point at their own help", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const projDir = join(home, ".claude", "projects", "-tmp-amb");
    await mkdir(projDir, { recursive: true });
    for (const id of ["one", "two"]) {
      await writeFile(join(projDir, `${id}.jsonl`), `{"type":"user","sessionId":"${id}","cwd":"/tmp/amb","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"x"}}\n`, "utf8");
    }
    const amb = await runCli(["at", "/tmp/amb"], { HOME: home });
    expect(amb.code).toBe(3);
    expect(amb.stderr).toMatch(/claude-code:one \(\S+\)/);
    const bare = await runCli(["claim"], { HOME: home });
    expect(bare.code).toBe(5);
    expect(bare.stderr).toMatch(/peek claim --help/);
    const gone = await runCli(["release", "00000000-0000-0000-0000-000000000000", "--claim-id"], { HOME: home });
    expect(gone.code).toBe(0);
    expect(gone.stdout).toMatch(/released 0 claims: nothing active matched/);
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
    expect(human.stdout).toMatch(/hidden low-signal: 1 session with no task or files \(--all shows them/);
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

    // An agent checking a file it is itself editing is not in conflict with anyone.
    const self = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/check", "--ignore-self"], { HOME: home, CLAUDE_SESSION_ID: "check" });
    expect(self.code).toBe(0);
    // A partial name gets a suggestion.
    const near = await runCli(["at", "chec"], { HOME: home });
    expect(near.code).toBe(2);
    expect(near.stderr).toMatch(/Did you mean: check-claude/);
    const named = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/check", "--ignore-session", "check-claude"], { HOME: home });
    expect(named.code).toBe(0);
    // Without identifying itself, the same call still reports the conflict.
    const other = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/check", "--ignore-self"], { HOME: home, CLAUDE_SESSION_ID: "someone-else" });
    expect(other.code).toBe(1);

    // `--files-from -` with a space, as the help text shows it, reads stdin.
    const viaStdin = await runCliWithStdin(["check", "--files-from", "-", "--cwd", "/tmp/check"], "src/core/engine.ts\nREADME.md\n", { HOME: home });
    expect(viaStdin.code).toBe(1);
    expect(viaStdin.stdout).toMatch(/conflict: 1 active file conflict/);
    expect(viaStdin.stdout).toMatch(/src\/core\/engine.ts/);
    // A space-separated line is several files, and paths that are not on disk are named.
    const spaced = await runCliWithStdin(["check", "--files-from", "-", "--cwd", "/tmp/check", "--json"], "src/core/engine.ts README.md\n", { HOME: home });
    expect(spaced.code).toBe(1);
    expect(JSON.parse(spaced.stdout).files.map((f: { file: string }) => f.file)).toEqual(["/tmp/check/README.md", "/tmp/check/src/core/engine.ts"]);
    expect(spaced.stderr).toMatch(/warning: 2 paths are not on disk/);

    // A subagent sidecar beside the parent: hidden by --files too, unless asked for.
    const subDir = join(projDir, "check", "subagents");
    await mkdir(subDir, { recursive: true });
    // The subagent must be writing something, or coord hides it as low-signal regardless.
    await writeFile(join(subDir, "agent-sub1.jsonl"), [
      `{"type":"user","sessionId":"check","agentId":"sub1","isSidechain":true,"cwd":"/tmp/check","timestamp":"${new Date().toISOString()}","message":{"role":"user","content":"edit the sub file"}}`,
      `{"type":"assistant","sessionId":"check","agentId":"sub1","isSidechain":true,"cwd":"/tmp/check","timestamp":"${new Date().toISOString()}","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/check/src/sub.ts"}}]}}`,
    ].join("\n") + "\n", "utf8");

    // A session with no task and no files yet is still a row here, as it is in plain list.
    await writeFile(join(projDir, "quiet.jsonl"), `{"type":"user","sessionId":"quiet","cwd":"/tmp/check","timestamp":"${new Date().toISOString()}","message":{"role":"user","content":"hi"}}\n`, "utf8");

    const files = await runCli(["list", "--files", "--adapter", "claude-code"], { HOME: home });
    expect(files.code).toBe(0);
    expect(files.stdout).toMatch(/FILES/);
    expect(files.stdout).toMatch(/check-claude-2/); // the quiet session, named from its cwd
    expect(files.stdout).not.toMatch(/ {20,}$/m);
    expect(files.stdout).toMatch(/writing: .*src\/core\/engine.ts/);
    expect(files.stdout).not.toMatch(/-sub\b/);
    const filesJson = JSON.parse((await runCli(["list", "--files", "--adapter", "claude-code", "--json"], { HOME: home })).stdout);
    expect(filesJson.every((s: { parentSessionId?: string }) => s.parentSessionId === undefined)).toBe(true);
    const withSubs = JSON.parse((await runCli(["list", "--files", "--adapter", "claude-code", "--json", "--include-subagents"], { HOME: home })).stdout);
    expect(withSubs.some((s: { parentSessionId?: string }) => s.parentSessionId === "check")).toBe(true);
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

    // The claim was made from this same directory by this same anonymous identity, so a
    // default check treats it as ours; --include-self shows it as another agent would see it.
    const conflict = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/claim", "--json", "--include-self"], { HOME: home });
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
    const bulk = await runCli(["check", "--files-from", filesList, "--cwd", "/tmp/claim", "--json", "--include-self"], { HOME: home });
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

    const stillClaimed = await runCli(["check", "src/core/engine.ts", "--cwd", "/tmp/claim", "--json", "--include-self"], { HOME: home });
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
    // Your own claim is not a conflict: check skips it by default, --include-self shows it,
    // and a repeat claim of the same files renews the first record instead of stacking.
    const own = await runCli(["check", "test-file.ts"], { HOME: home, CLAUDE_SESSION_ID: "sess-42" });
    expect(own.code).toBe(0);
    const shown = await runCli(["check", "test-file.ts", "--include-self"], { HOME: home, CLAUDE_SESSION_ID: "sess-42" });
    expect(shown.code).toBe(1);
    expect(shown.stdout).toMatch(/conflict: 1 active file conflict/);
    expect(shown.stdout).toMatch(/\(yours\? --as claude-code:sess-42\)/);
    const again = await runCli(["claim", "test-file.ts", "--json"], { HOME: home, CLAUDE_SESSION_ID: "sess-42" });
    expect(JSON.parse(again.stdout).id).toBe(JSON.parse(r.stdout).id);
    const still = await runCli(["check", "test-file.ts", "--include-self"], { HOME: home, CLAUDE_SESSION_ID: "sess-42" });
    expect(still.stdout).toMatch(/conflict: 1 active file conflict/);
    // Someone else sees it either way.
    const other = await runCli(["check", "test-file.ts"], { HOME: home, CLAUDE_SESSION_ID: "sess-99" });
    expect(other.code).toBe(1);
    // A claim given a display owner with --as still belongs to the session that made it.
    const named = await runCli(["claim", "named-file.ts", "--as", "codex-review", "--json"], { HOME: home, CLAUDE_SESSION_ID: "sess-42" });
    expect(JSON.parse(named.stdout)).toMatchObject({ owner: "codex-review", creator: "claude-code:sess-42" });
    const namedSelf = await runCli(["check", "named-file.ts"], { HOME: home, CLAUDE_SESSION_ID: "sess-42" });
    expect(namedSelf.code).toBe(0);
    const namedOther = await runCli(["check", "named-file.ts"], { HOME: home, CLAUDE_SESSION_ID: "sess-99" });
    expect(namedOther.code).toBe(1);
    expect(namedOther.stdout).toMatch(/made by claude-code:sess-42/);
    // Untracked agents are identified by user, host and directory: no pid, so a later
    // process in the same directory is still "you". peek says it fell back.
    const anon = await runCli(["claim", "other-file.ts"], { HOME: home });
    expect(anon.code).toBe(0);
    expect(anon.stdout).toMatch(/owner: \S+@\S+:\//);
    expect(anon.stderr).toMatch(/identity: no tracked session found for this directory/);
    const anonSelf = await runCli(["check", "other-file.ts"], { HOME: home });
    expect(anonSelf.code).toBe(0);
    const claim = JSON.parse(r.stdout);
    expect(claim.owner).toBe("claude-code:sess-42");
  });

  it("doctor shows adapter availability", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-cli-"));
    const r = await runCli(["doctor"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/agent-peek \d+\.\d+\.\d+/);
    // ADAPTER and "next:" were ALLCAPS/label chrome that ticket 15 replaced with rules
    // and a command list. Assert what the report must SAY rather than how it is decorated,
    // so a restyle does not fail and a lost capability does.
    expect(r.stdout).toMatch(/claude-code/);
    expect(r.stdout).toMatch(/tmux/);
    // every adapter is accounted for under some status heading
    expect(r.stdout).toMatch(/── (ready|opt-in|needs command|not found) ─/);
    // the follow-on commands are still offered
    expect(r.stdout).toMatch(/peek agents/);
    expect(r.stdout).toMatch(/peek list --terminals/);
  });
});

describe("skills --json segmentation", () => {
  it("labels every skill with its segment and carries per-segment totals", async () => {
    // Without this a consumer cannot reproduce the segmentation that makes the tool
    // safe to act on: the human report says a skill is archivable and the JSON did not
    // say which bucket anything was in, so verifying "no archivable row lacks a mutable
    // installation" from the outside was impossible.
    const r = await runCli(["skills", "--json", "--details"]);
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
    //
    // Asserted against what this machine actually has rather than a fixed count: the
    // first version required three states and an `unconfirmed` agent, which held on the
    // machine it was written on and failed on a clean CI runner where every agent is
    // absent. That tested the environment, not the code. Whatever states the JSON
    // reports must each appear as a readable word in the plain-text output.
    const [text, json] = await Promise.all([
      runCli(["agents", "--all"]),
      runCli(["agents", "--all", "--json"]),
    ]);
    const reported = new Set<string>(
      (JSON.parse(json.stdout).agents as { presence: string }[]).map((a) => a.presence),
    );
    expect(reported.size).toBeGreaterThan(0);
    for (const state of reported) {
      // "no-convention" renders as "no convention": the word is what must survive, not
      // the identifier.
      const word = state.replace("-", " ");
      expect(text.stdout.includes(word), `state "${state}" not readable in plain text`).toBe(true);
    }
    expect(text.stdout.includes(String.fromCharCode(27))).toBe(false);
  }, 60000);
});
