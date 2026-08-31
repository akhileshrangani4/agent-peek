// test/helpers/fresh-dist.ts
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/**
 * Integration tests spawn `bin/peek.js`, which runs `dist/` — so without this they
 * silently test whatever was last built. A stale `dist` makes a new feature look broken
 * and a removed bug look present, and the failure reads as a real defect: it cost one
 * session a debugging session and nearly a false report of a colleague's work.
 *
 * Fail loudly with the fix rather than letting the suite report a result it never
 * measured.
 */
export function assertDistFresh(root = process.cwd()): void {
  let distTime: number;
  try {
    distTime = newestMtime(join(root, "dist"));
  } catch {
    throw new Error("dist/ is missing. Run `npm run build` before the integration tests.");
  }
  const srcTime = newestMtime(join(root, "src"));
  if (srcTime > distTime) {
    throw new Error(
      "dist/ is older than src/. These tests spawn the built CLI, so they would be "
      + "testing a stale build and reporting a result they never measured. "
      + "Run `npm run build` first.",
    );
  }
}
