import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { NotAProjectError } from "../core/errors.js";
import type { Engine } from "../core/engine.js";
import type { PostAuthor } from "./schema.js";

const execFileAsync = promisify(execFile);

export function hashKey(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 5_000 });
    const out = stdout.trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** "git@github.com:o/r.git" | "https://github.com/o/r" -> "gh:o/r"; other hosts -> "host/o/r" */
export function normalizeRemote(remote: string): string {
  let url = remote.trim().replace(/\.git$/, "");
  const ssh = url.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/);
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
  url = url.replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
  if (url.startsWith("github.com/")) return `gh:${url.slice("github.com/".length)}`;
  return url;
}

export async function projectIdentity(dir: string): Promise<{ id: string; label: string }> {
  const abs = resolve(dir);
  if (!existsSync(abs)) throw new NotAProjectError(dir);
  const remote = await git(abs, ["remote", "get-url", "origin"]);
  if (remote) {
    const label = normalizeRemote(remote);
    return { id: hashKey(label), label };
  }
  const commonDir = await git(abs, ["rev-parse", "--git-common-dir"]);
  if (commonDir) {
    const absCommon = realpathSync(resolve(abs, commonDir));
    return { id: hashKey(absCommon), label: absCommon };
  }
  const real = realpathSync(abs);
  return { id: hashKey(real), label: real };
}

export async function resolveAuthor(opts: { as?: string; cwd: string; engine?: Engine }): Promise<PostAuthor> {
  if (opts.as) return { session: opts.as, name: opts.as };
  const claudeSession = process.env.CLAUDE_SESSION_ID;
  if (claudeSession) return { session: `claude-code:${claudeSession}`, adapter: "claude-code" };
  if (opts.engine) {
    try {
      const sessions = await opts.engine.list({ includeTerminal: false });
      const cwd = resolve(opts.cwd);
      const match = sessions.find((entry) =>
        entry.status !== "ended" && entry.cwd && (cwd === entry.cwd || cwd.startsWith(`${entry.cwd}/`) || entry.cwd.startsWith(`${cwd}/`)),
      );
      if (match) return { session: match.id, adapter: match.adapter, name: match.tag };
    } catch { /* fall through to anonymous */ }
  }
  return { session: `${userInfo().username}@${hostname()}`, anonymous: true };
}
