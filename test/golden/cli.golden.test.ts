// test/golden/cli.golden.test.ts
//
// D3.1 baseline, CLI half: what every one of the 22 `peek` commands prints on the golden
// fixture home, with its exit code. The service-layer refactor (D3) must leave each
// golden unchanged; a deliberate output change re-records the goldens in its own commit
// so the diff is the review.
//
// Cases run in order against one home, because several commands are only meaningful
// after another (`untag` after `tag`, `expand` after `post`). JSON output is used
// wherever the command offers `--json`; the commands that have no `--json` option
// (`adapters`, `tag`, `untag`, `register`, `forget`, `help`, `ui`) are recorded as text,
// which is what a script reading them sees. Volatile values are normalised by
// normalize.ts and nowhere else.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODEX_SESSION, assertFixtureCwdsAbsent, makeFixtureHome, type FixtureHome } from "./fixture-home.js";
import { assertDistFresh, cliRecord, expectGolden, runCli, type CliRun } from "./harness.js";
import { Normalizer } from "./normalize.js";

/** The 22 commands `peek --help` lists in 0.6.0. Every one must have at least one case. */
export const CLI_COMMANDS_0_6 = [
  "help", "version", "update", "list", "check", "claim", "release", "coord", "at", "tag", "untag",
  "register", "forget", "agents", "usage", "skills", "adapters", "ui", "post", "feed", "expand", "doctor",
] as const;

interface CliCase {
  /** Golden file name: `__snapshots__/cli/<name>.json`. */
  name: string;
  /** The 0.6.0 command this case exercises; checked against CLI_COMMANDS_0_6. */
  command: (typeof CLI_COMMANDS_0_6)[number];
  /** Arguments after the command. A function sees earlier runs (e.g. the post id). */
  args: string[] | ((ctx: { fixture: FixtureHome; runs: Map<string, CliRun> }) => string[]);
  /** The exit code 0.6.0 returns; asserted directly so a mismatch names the cause. */
  exit: number;
}

const CODEX = `codex:${CODEX_SESSION}`;

const CASES: CliCase[] = [
  { name: "help", command: "help", args: [], exit: 0 },
  { name: "help-coord", command: "help", args: ["coord"], exit: 0 },
  { name: "version", command: "version", args: ["--json"], exit: 0 },
  { name: "update-check", command: "update", args: ["--check", "--json"], exit: 0 },
  { name: "adapters", command: "adapters", args: [], exit: 0 },
  { name: "doctor", command: "doctor", args: ["--json"], exit: 0 },
  { name: "agents", command: "agents", args: ["--json"], exit: 0 },
  { name: "list-all", command: "list", args: ["--all", "--json"], exit: 0 },
  { name: "list-active", command: "list", args: ["--json"], exit: 0 },
  { name: "at-raw", command: "at", args: ["claude-code:s1", "--json"], exit: 0 },
  { name: "at-raw-tools", command: "at", args: ["claude-code:s2", "--tools", "--json"], exit: 0 },
  { name: "at-structured", command: "at", args: ["claude-code:s1", "--mode", "structured", "--json"], exit: 0 },
  { name: "at-summary", command: "at", args: [CODEX, "--mode", "summary", "--json"], exit: 0 },
  { name: "at-handoff-local", command: "at", args: [CODEX, "--mode", "handoff", "--local", "--json"], exit: 0 },
  { name: "at-unknown", command: "at", args: ["claude-code:missing", "--json"], exit: 2 },
  { name: "coord", command: "coord", args: ["/tmp/repo", "--all", "--json"], exit: 0 },
  { name: "tag", command: "tag", args: ["claude-code:s1", "as", "golden-main"], exit: 0 },
  { name: "at-by-tag-brief", command: "at", args: ["golden-main", "--mode", "brief", "--json"], exit: 0 },
  { name: "untag", command: "untag", args: ["golden-main"], exit: 0 },
  { name: "register", command: "register", args: ({ fixture }) => ["custom:worker-1", "at", `${fixture.home}/worker.jsonl`, "--as", "worker", "--cwd", "/tmp/repo"], exit: 0 },
  { name: "list-after-register", command: "list", args: ["--all", "--json"], exit: 0 },
  { name: "forget", command: "forget", args: ["custom:worker-1"], exit: 0 },
  { name: "claim", command: "claim", args: ["src/verify.ts", "--as", "golden-agent", "--ttl", "1h", "--json"], exit: 0 },
  { name: "check-own-claim-ignored", command: "check", args: ["src/verify.ts", "--json"], exit: 0 },
  { name: "check-include-self", command: "check", args: ["src/verify.ts", "--include-self", "--json"], exit: 1 },
  { name: "release", command: "release", args: ["src/verify.ts", "--json"], exit: 0 },
  { name: "check-after-release", command: "check", args: ["src/verify.ts", "--include-self", "--json"], exit: 0 },
  { name: "post", command: "post", args: ["finding", "Auth lives in auth.ts", "--text", "login() is defined in auth.ts", "--paths", "auth.ts", "--topics", "auth", "--as", "golden-agent", "--json"], exit: 0 },
  { name: "post-invalid", command: "post", args: ["finding", "No paths", "--text", "findings need paths", "--json"], exit: 5 },
  { name: "feed", command: "feed", args: ({ fixture }) => [fixture.project, "--json"], exit: 0 },
  {
    name: "expand",
    command: "expand",
    args: ({ runs }) => {
      const post = JSON.parse(runs.get("post")!.stdout) as { id: string };
      return [post.id, "--json"];
    },
    exit: 0,
  },
  { name: "expand-unknown", command: "expand", args: ["000000000-00000000", "--json"], exit: 2 },
  { name: "usage", command: "usage", args: ["--json"], exit: 0 },
  { name: "usage-all-tools", command: "usage", args: ["tool", "--all-tools", "--json"], exit: 0 },
  { name: "skills", command: "skills", args: ["--json"], exit: 0 },
  { name: "skills-detail", command: "skills", args: ["--skill", "golden-skill", "--json"], exit: 0 },
  { name: "skills-archive-plan", command: "skills", args: ["archive", "idle-skill", "--json"], exit: 0 },
  { name: "ui-without-tty", command: "ui", args: [], exit: 5 },
  { name: "unknown-option", command: "ui", args: ["--json"], exit: 5 },
];

describe("CLI golden output (0.6.0 baseline)", () => {
  let fixture: FixtureHome;
  let normalizer: Normalizer;
  const runs = new Map<string, CliRun>();

  beforeAll(async () => {
    assertDistFresh();
    assertFixtureCwdsAbsent();
    fixture = await makeFixtureHome();
    normalizer = new Normalizer({ home: fixture.home, runStartedAt: Date.now(), stableIds: [CODEX_SESSION] });
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  it("covers every 0.6.0 command", () => {
    const covered = new Set(CASES.map((c) => c.command));
    expect(CLI_COMMANDS_0_6.filter((command) => !covered.has(command))).toEqual([]);
  });

  for (const testCase of CASES) {
    it(`peek ${testCase.name}`, async () => {
      const rest = typeof testCase.args === "function" ? testCase.args({ fixture, runs }) : testCase.args;
      const args = [testCase.command, ...rest];
      const run = runCli(args, { cwd: fixture.project, env: fixture.env });
      runs.set(testCase.name, run);
      expect(run.exit, `exit code of peek ${args.join(" ")}\nstderr: ${run.stderr}`).toBe(testCase.exit);
      await expectGolden("cli", testCase.name, cliRecord(run, normalizer));
    });
  }
});
