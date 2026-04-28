// src/core/registry.ts
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import type { SessionEntry } from "./types.js";
import { RegistryLockTimeoutError } from "./errors.js";

export interface RegistryOptions {
  home?: string;
  staleMs?: number;
}

interface RegistryFile {
  version: 1;
  sessions: Record<string, SessionEntry>;
}

export class Registry {
  private readonly dir: string;
  private readonly path: string;
  private readonly staleMs: number;

  constructor(opts: RegistryOptions = {}) {
    const home = opts.home ?? homedir();
    this.dir = join(home, ".agent-peek");
    this.path = join(this.dir, "registry.json");
    this.staleMs = opts.staleMs ?? 24 * 3600 * 1000;
  }

  async list(): Promise<SessionEntry[]> {
    const f = await this.read();
    return Object.values(f.sessions);
  }

  async get(id: string): Promise<SessionEntry | undefined> {
    const f = await this.read();
    return f.sessions[id];
  }

  async upsert(entry: SessionEntry): Promise<void> {
    await this.write((f) => {
      f.sessions[entry.id] = { ...f.sessions[entry.id], ...entry };
    });
  }

  async remove(id: string): Promise<void> {
    await this.write((f) => { delete f.sessions[id]; });
  }

  async pruneStale(): Promise<number> {
    const cutoff = Date.now() - this.staleMs;
    let count = 0;
    await this.write((f) => {
      for (const e of Object.values(f.sessions)) {
        if (e.status !== "ended" && Date.parse(e.lastSeen) < cutoff) {
          e.status = "ended";
          count++;
        }
      }
    });
    return count;
  }

  private async read(): Promise<RegistryFile> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.path)) return { version: 1, sessions: {} };
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return { version: 1, sessions: {} };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && typeof parsed.sessions === "object") return parsed;
      throw new Error("bad shape");
    } catch {
      const backup = join(this.dir, `registry.corrupt-${Date.now()}.json`);
      try { await rename(this.path, backup); } catch { /* ignore */ }
      // eslint-disable-next-line no-console
      console.warn(`[agent-peek] registry corrupt, backed up to ${backup}`);
      return { version: 1, sessions: {} };
    }
  }

  private async write(mutator: (f: RegistryFile) => void): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.path)) {
      await writeFile(this.path, JSON.stringify({ version: 1, sessions: {} }), "utf8");
    }
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.path, {
        retries: { retries: 30, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
        stale: 10_000,
        realpath: false,
      });
    } catch (e) {
      throw new RegistryLockTimeoutError();
    }
    try {
      const f = await this.read();
      mutator(f);
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(f, null, 2), "utf8");
      await rename(tmp, this.path);
    } finally {
      await release();
    }
  }
}
