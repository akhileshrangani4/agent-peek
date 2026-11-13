// test/golden/harness.ts
//
// Shared plumbing for the CLI and MCP golden suites: run a built binary against the
// fixture home, turn what it printed into a normalised record, and compare that record
// with the checked-in golden file.
//
// Goldens live in test/golden/__snapshots__/<suite>/<case>.json, one file per case, so a
// behaviour change shows up as a reviewable diff of exactly the cases it touched. They
// are written by `npx vitest run test/golden -u` and nowhere else; in CI (CI=true)
// Vitest refuses to create a missing golden, so an unrecorded case fails instead of
// silently passing.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect } from "vitest";
import { assertDistFresh as assertBuiltDistFresh } from "../helpers/fresh-dist.js";
import { REPO_ROOT } from "./fixture-home.js";
import type { Normalizer } from "./normalize.js";

export const PEEK_BIN = join(REPO_ROOT, "bin/peek.js");
export const MCP_BIN = join(REPO_ROOT, "bin/agent-peek-mcp.js");
export const SNAPSHOT_DIR = join(REPO_ROOT, "test/golden/__snapshots__");

/**
 * The goldens run the built package (bin/ imports dist/), because the bins are what users
 * and MCP clients execute; a stale dist/ would compare the wrong code.
 */
export function assertDistFresh(): void {
  assertBuiltDistFresh(REPO_ROOT);
}

export interface CliRun {
  argv: string[];
  exit: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], opts: { cwd: string; env: Record<string, string> }): CliRun {
  const result = spawnSync(process.execPath, [PEEK_BIN, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { argv: args, exit: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Parse a stream for the record: JSON when it is JSON (every `--json` command), otherwise
 * the text split into lines, so a golden diff points at the line that moved.
 */
export function structure(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not JSON after all (e.g. text that opens with a bracket); record it as lines.
    }
  }
  return text.replace(/\n$/, "").split("\n");
}

export function cliRecord(run: CliRun, normalizer: Normalizer): unknown {
  return normalizer.value({
    argv: run.argv,
    exit: run.exit,
    stdout: structure(run.stdout),
    stderr: structure(run.stderr),
  });
}

export function serialize(record: unknown): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function expectGolden(suite: "cli" | "mcp", name: string, record: unknown): Promise<void> {
  await expect(serialize(record)).toMatchFileSnapshot(join(SNAPSHOT_DIR, suite, `${name}.json`));
}

export interface SurfaceProjection<T extends { name: string }> {
  /** The live entries whose names were in the 0.6.0 baseline, in baseline order. */
  recorded: T[];
  /** Baseline names the live surface no longer has: a breaking removal. */
  missing: string[];
  /** Live names the baseline did not have: allowed additions, listed for the PR record. */
  added: string[];
}

/**
 * The Compatibility table lets `tools/list` (and prompts) gain entries but never lose or
 * change one. So the golden records only the baseline's names: a later PR that adds a
 * tool leaves the golden untouched, while one that removes, renames or reshapes a
 * baseline tool changes `recorded` or `missing` and fails.
 */
export function projectOntoBaseline<T extends { name: string }>(live: T[], baseline: readonly string[]): SurfaceProjection<T> {
  const byName = new Map(live.map((entry) => [entry.name, entry]));
  const recorded: T[] = [];
  const missing: string[] = [];
  for (const name of baseline) {
    const entry = byName.get(name);
    if (entry) recorded.push(entry);
    else missing.push(name);
  }
  const known = new Set(baseline);
  const added = live.map((entry) => entry.name).filter((name) => !known.has(name));
  return { recorded, missing, added };
}
