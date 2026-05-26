import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type { FileClaim } from "./types.js";
import { RegistryLockTimeoutError } from "./errors.js";

export interface ClaimsOptions {
  home?: string;
}

interface ClaimsFile {
  version: 1;
  claims: Record<string, FileClaim>;
}

export class ClaimsStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(opts: ClaimsOptions = {}) {
    const home = opts.home ?? homedir();
    this.dir = join(home, ".agent-peek");
    this.path = join(this.dir, "claims.json");
  }

  async list(now: Date = new Date()): Promise<FileClaim[]> {
    const file = await this.read();
    return Object.values(file.claims)
      .filter((claim) => !isExpired(claim, now))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async claim(opts: {
    files: string[];
    owner: string;
    cwd?: string;
    ttlMs: number;
    now?: Date;
  }): Promise<FileClaim> {
    const now = opts.now ?? new Date();
    const claim: FileClaim = {
      id: randomUUID(),
      files: [...new Set(opts.files)].sort(),
      owner: opts.owner,
      cwd: opts.cwd,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + opts.ttlMs).toISOString(),
    };
    await this.write((file) => {
      pruneExpired(file, now);
      file.claims[claim.id] = claim;
    });
    return claim;
  }

  async release(selector: string, now: Date = new Date()): Promise<number> {
    let released = 0;
    await this.write((file) => {
      pruneExpired(file, now);
      for (const [id, claim] of Object.entries(file.claims)) {
        if (id === selector || claim.files.includes(selector)) {
          delete file.claims[id];
          released++;
        }
      }
    });
    return released;
  }

  private async read(): Promise<ClaimsFile> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.path)) return { version: 1, claims: {} };
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return { version: 1, claims: {} };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && typeof parsed.claims === "object") return parsed;
      throw new Error("bad shape");
    } catch {
      const backup = join(this.dir, `claims.corrupt-${Date.now()}.json`);
      try { await rename(this.path, backup); } catch { /* ignore */ }
      return { version: 1, claims: {} };
    }
  }

  private async write(mutator: (file: ClaimsFile) => void): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.path)) {
      await writeFile(this.path, JSON.stringify({ version: 1, claims: {} }), "utf8");
    }
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.path, {
        retries: { retries: 5, minTimeout: 50, maxTimeout: 500, factor: 2 },
        stale: 10_000,
        realpath: false,
      });
    } catch {
      throw new RegistryLockTimeoutError();
    }
    try {
      const file = await this.read();
      mutator(file);
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
      try {
        await rename(tmp, this.path);
      } catch (err) {
        await unlink(tmp).catch(() => { /* ignore */ });
        throw err;
      }
    } finally {
      await release();
    }
  }
}

function pruneExpired(file: ClaimsFile, now: Date): void {
  for (const [id, claim] of Object.entries(file.claims)) {
    if (isExpired(claim, now)) delete file.claims[id];
  }
}

function isExpired(claim: FileClaim, now: Date): boolean {
  return Date.parse(claim.expiresAt) <= now.getTime();
}
