// test/helpers/tmp-home.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTmpHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), "agent-peek-"));
  return {
    home,
    cleanup: async () => { await rm(home, { recursive: true, force: true }); },
  };
}

export function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T> | T): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prior[k] = process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      for (const k of Object.keys(vars)) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k]!;
      }
    });
}
