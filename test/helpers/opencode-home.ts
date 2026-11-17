// test/helpers/opencode-home.ts
import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const FIXTURES = resolve(__dirname, "../fixtures/opencode");

export interface OpencodeHome {
  /** XDG_DATA_HOME for the run. */
  data: string;
  /** `<data>/opencode`, where OpenCode keeps opencode.db and storage/. */
  dir: string;
}

/** A temp XDG data dir holding whichever OpenCode stores the test asks for. */
export async function makeOpencodeHome(opts: { v2?: boolean; legacy?: boolean } = {}): Promise<OpencodeHome> {
  const data = await mkdtemp(join(tmpdir(), "opencode-data-"));
  const dir = join(data, "opencode");
  await mkdir(dir, { recursive: true });
  if (opts.v2) await writeV2Database(join(dir, "opencode.db"));
  if (opts.legacy) await cp(join(FIXTURES, "legacy-v1", "storage"), join(dir, "storage"), { recursive: true });
  return { data, dir };
}

/** Build a V2 database from test/fixtures/opencode/v2/opencode.sql with node:sqlite. */
export async function writeV2Database(path: string, extraSql = ""): Promise<void> {
  const sql = await readFile(join(FIXTURES, "v2", "opencode.sql"), "utf8");
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
    if (extraSql) db.exec(extraSql);
  } finally {
    db.close();
  }
}

/**
 * Env for an adapter run against `home`: OpenCode's own overrides are blanked so the
 * developer's real environment can't leak in. A blank value counts as unset.
 */
export function opencodeEnv(home: OpencodeHome, extra: Record<string, string> = {}): Record<string, string> {
  return { XDG_DATA_HOME: home.data, OPENCODE_DB: "", OPENCODE_DISABLE_CHANNEL_DB: "", ...extra };
}
