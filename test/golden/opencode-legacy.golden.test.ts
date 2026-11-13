// test/golden/opencode-legacy.golden.test.ts
//
// OpenCode's pre-V2 filesystem storage, as 0.6.0 read it. These goldens were recorded
// against the release/0.7.0 base (5e40e0e), whose `opencode` adapter is the 0.6.0 one,
// before the V2 adapter landed. The V2 work must leave them byte-identical: a legacy
// session keeps its `opencode:<id>` selector, its `adapter: "opencode"` and its cursor.
//
// The fixture home here is the shared golden home plus the legacy storage tree, kept in
// its own suite so the 0.6.0 CLI goldens (which have no OpenCode data) stay untouched.
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CODEX_SESSION, REPO_ROOT, assertFixtureCwdsAbsent, makeFixtureHome, type FixtureHome } from "./fixture-home.js";
import { assertDistFresh, cliRecord, expectGolden, runCli, type CliRun } from "./harness.js";
import { Normalizer } from "./normalize.js";

const LEGACY_STORAGE = join(REPO_ROOT, "test/fixtures/opencode/legacy-v1/storage");

interface LegacyCase {
  name: string;
  args: string[] | ((runs: Map<string, CliRun>) => string[]);
  exit: number;
}

const CASES: LegacyCase[] = [
  { name: "opencode-legacy-list", args: ["list", "--adapter", "opencode", "--all", "--json"], exit: 0 },
  { name: "opencode-legacy-at", args: ["at", "opencode:ses_legacy", "--tools", "--json"], exit: 0 },
  {
    // A cursor 0.6.0 handed out still decodes and reads nothing new.
    name: "opencode-legacy-at-since",
    args: (runs) => {
      const first = JSON.parse(runs.get("opencode-legacy-at")!.stdout) as { nextCursor: string };
      return ["at", "opencode:ses_legacy", "--since", first.nextCursor, "--json"];
    },
    exit: 0,
  },
  { name: "opencode-legacy-at-shared", args: ["at", "opencode:ses_shared", "--json"], exit: 0 },
];

describe("OpenCode legacy storage golden output (0.6.0 baseline)", () => {
  let fixture: FixtureHome;
  let normalizer: Normalizer;
  const runs = new Map<string, CliRun>();

  beforeAll(async () => {
    assertDistFresh();
    assertFixtureCwdsAbsent();
    fixture = await makeFixtureHome();
    await cp(LEGACY_STORAGE, join(fixture.home, ".local/share/opencode/storage"), { recursive: true });
    normalizer = new Normalizer({ home: fixture.home, runStartedAt: Date.now(), stableIds: [CODEX_SESSION] });
  });

  afterAll(async () => {
    await fixture?.cleanup();
  });

  for (const testCase of CASES) {
    it(`peek ${testCase.name}`, async () => {
      const args = typeof testCase.args === "function" ? testCase.args(runs) : testCase.args;
      const run = runCli(args, { cwd: fixture.project, env: fixture.env });
      runs.set(testCase.name, run);
      expect(run.exit, `exit code of peek ${args.join(" ")}\nstderr: ${run.stderr}`).toBe(testCase.exit);
      await expectGolden("cli", testCase.name, cliRecord(run, normalizer));
    });
  }
});
