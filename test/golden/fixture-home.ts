// test/golden/fixture-home.ts
//
// The golden fixture home: one throwaway $HOME, built the same way on every run, that the
// CLI and MCP golden suites point the built binaries at. It reuses the checked-in
// transcripts under test/fixtures/ rather than inventing new ones, so the goldens record
// what 0.6.0 does with the inputs the rest of the suite already trusts.
//
// Everything that could make two runs differ is pinned here, not papered over later:
//   - transcripts are copied byte for byte, so byte-offset cursors are identical on any
//     machine; their sessions' cwd is the fixtures' own `/tmp/repo` (and `/tmp/repo2`),
//     which `assertFixtureCwdsAbsent` checks no real directory shadows;
//   - every file's mtime is FIXTURE_MTIME, so session status is `ended` and lastSeen is
//     a fixed instant on any machine whose clock is past it;
//   - the project has an `origin` remote, so its project id is the hash of that remote,
//     not of the temp path;
//   - PATH holds only `node` and `git`, so `doctor`, adapters and agent detection see
//     the same toolset in CI and locally (no tmux, screen, sqlite3 or agent CLIs);
//   - the environment is built from scratch (no inherited API keys, XDG dirs, or
//     CLAUDE_SESSION_ID), so identity and summary paths cannot leak in from the host.
//
// What remains volatile (temp paths, the instant a post or claim is written, generated
// ids) is handled by `normalize.ts`, in one place.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../..");
const FIXTURES = join(REPO_ROOT, "test/fixtures");

/** Every fixture file carries this mtime. It is after the newest transcript timestamp. */
export const FIXTURE_MTIME = new Date("2026-04-28T14:00:00.000Z");
/** The fixture project's remote. Project ids derive from it, so they are stable. */
export const FIXTURE_REMOTE = "https://github.com/agent-peek/golden-fixture.git";
/** The Codex rollout's session id, from test/fixtures/codex/multi-turn. */
export const CODEX_SESSION = "019cbabb-1261-7393-8ae4-007653e6c643";

export interface FixtureHome {
  /** The temp $HOME (realpath, so it matches what the CLI prints). */
  home: string;
  /** A git checkout inside $HOME with an origin remote: the feed and claims project. */
  project: string;
  /** The environment every spawned process runs with. */
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

function which(bin: string): string {
  return execFileSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).trim();
}

/**
 * The cwd the checked-in transcripts record. Coordination filters on paths that exist on
 * the reader's disk, so a real directory here would change the goldens.
 */
export const FIXTURE_CWDS = ["/tmp/repo", "/tmp/repo2"] as const;

export function assertFixtureCwdsAbsent(): void {
  for (const dir of FIXTURE_CWDS) {
    if (existsSync(dir)) {
      throw new Error(`${dir} exists on this machine. The golden fixtures record sessions whose cwd is ${dir}; remove it so the goldens measure the fixture, not this disk.`);
    }
  }
}

/** Copy a checked-in transcript verbatim. */
async function copyTranscript(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, await readFile(join(FIXTURES, src)));
}

async function pinMtimes(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await pinMtimes(path);
    await utimes(path, FIXTURE_MTIME, FIXTURE_MTIME);
  }
}

export async function makeFixtureHome(): Promise<FixtureHome> {
  const home = realpathSync(await mkdtemp(join(tmpdir(), "ap-golden-")));
  const project = join(home, "repo");

  // A git project with a stable identity and the files the transcripts mention.
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "auth.ts"), "export function login(){}\n", "utf8");
  await writeFile(join(project, "src/verify.ts"), "export const verify = () => true;\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync("git", ["remote", "add", "origin", FIXTURE_REMOTE], { cwd: project });

  // Claude Code: the multi-turn and mid-tool-call fixtures, plus one session that invokes
  // a skill so the usage index and skills report have a row to record.
  const claudeProjects = join(home, ".claude/projects/-repo");
  await copyTranscript("claude-code/multi-turn/transcript.jsonl", join(claudeProjects, "s1.jsonl"));
  await copyTranscript("claude-code/mid-tool-call/transcript.jsonl", join(claudeProjects, "s2.jsonl"));
  const cwd = FIXTURE_CWDS[0];
  const skillSession = [
    { type: "user", sessionId: "s3", cwd, timestamp: "2026-04-28T13:30:00.000Z", uuid: "u1", parentUuid: null, isSidechain: false, message: { role: "user", content: "use the golden skill" } },
    { type: "assistant", sessionId: "s3", cwd, timestamp: "2026-04-28T13:30:01.000Z", uuid: "a1", parentUuid: "u1", isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_g1", name: "Skill", input: { skill: "golden-skill" } }] } },
    { type: "user", sessionId: "s3", cwd, timestamp: "2026-04-28T13:30:02.000Z", uuid: "u2", parentUuid: "a1", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_g1", content: "loaded" }] } },
  ];
  await writeFile(join(claudeProjects, "s3.jsonl"), skillSession.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  // Codex: the multi-turn rollout under the dated layout the adapter walks.
  await copyTranscript(
    "codex/multi-turn/transcript.jsonl",
    join(home, `.codex/sessions/2026/04/28/rollout-2026-04-28T12-00-00-${CODEX_SESSION}.jsonl`),
  );

  // A transcript outside every adapter root, for `peek register` to adopt.
  await copyTranscript("claude-code/multi-turn/transcript.jsonl", join(home, "worker.jsonl"));

  // Two installed skills: one the transcripts invoke, one nothing does.
  for (const [name, description] of [["golden-skill", "A skill the fixture session invokes."], ["idle-skill", "A skill nothing invokes."]]) {
    const dir = join(home, ".claude/skills", name!);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nFixture skill.\n`, "utf8");
  }

  // A PATH holding only what the CLI legitimately needs.
  const bin = join(home, ".golden-bin");
  await mkdir(bin, { recursive: true });
  await symlink(process.execPath, join(bin, "node"));
  await symlink(which("git"), join(bin, "git"));

  await pinMtimes(home);

  const env: Record<string, string> = {
    HOME: home,
    PATH: bin,
    TZ: "UTC",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    // `update` asks npm for the latest version unless this is set; the golden must not
    // depend on the registry.
    AGENT_PEEK_LATEST_VERSION: "0.0.0",
    // git refuses to read a repo it considers unsafe when HOME has no config; keep it quiet.
    GIT_CONFIG_NOSYSTEM: "1",
  };

  return {
    home,
    project,
    env,
    cleanup: async () => { await rm(home, { recursive: true, force: true }); },
  };
}
