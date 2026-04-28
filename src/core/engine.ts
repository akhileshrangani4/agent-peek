import type { Registry } from "./registry.js";
import type { AdapterLoader } from "../adapters/loader.js";
import type {
  SessionEntry, PeekResult, SnapshotMode, Cursor,
} from "./types.js";
import {
  SessionNotFoundError, AmbiguousSelectorError, AdapterError,
} from "./errors.js";
import { toRaw, toStructured, toSummary } from "./snapshot.js";
import { decodeCursor, cursorAdapter } from "./cursor.js";

export interface PeekOpts {
  mode?: SnapshotMode;
  since?: Cursor;
  limit?: number;
}

export interface RegisterOpts {
  id: string;
  adapter: string;
  transcriptPath: string;
  cwd?: string;
  tag?: string;
  pid?: number;
}

export class Engine {
  constructor(private readonly deps: { registry: Registry; loader: AdapterLoader }) {}

  async list(filter?: { adapter?: string; status?: SessionEntry["status"] }): Promise<SessionEntry[]> {
    const { registry, loader } = this.deps;
    const scans = await Promise.allSettled(loader.all().map((a) => a.scan()));
    for (let i = 0; i < scans.length; i++) {
      const r = scans[i]!;
      if (r.status === "fulfilled") {
        for (const e of r.value) await registry.upsert(e);
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[agent-peek] adapter scan failed: ${(r.reason as Error).message}`);
      }
    }
    let list = await registry.list();
    if (filter?.adapter) list = list.filter((e) => e.adapter === filter.adapter);
    if (filter?.status) list = list.filter((e) => e.status === filter.status);
    return list.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  async peek(selector: string, opts: PeekOpts = {}): Promise<PeekResult> {
    const entry = await this.resolve(selector);
    const adapter = this.deps.loader.get(entry.adapter);
    let cursor = opts.since;
    if (cursor) {
      const adapterFromCursor = cursorAdapter(cursor);
      if (adapterFromCursor !== entry.adapter) {
        throw new AdapterError(entry.adapter,
          `cursor was issued by adapter "${adapterFromCursor}"`);
      }
    }
    const result = await adapter.read(entry, cursor);
    const messages = result.messages;
    const mode: SnapshotMode = opts.mode ?? "raw";
    let snapshot;
    if (mode === "raw") snapshot = toRaw(entry.id, messages, { limit: opts.limit ?? 200 });
    else if (mode === "structured") snapshot = toStructured(entry.id, messages);
    else snapshot = await toSummary(entry.id, messages, {
      deltaMessageCount: messages.length,
      cacheKey: result.nextCursor,
    });
    return { snapshot, nextCursor: result.nextCursor, eof: result.eof };
  }

  async register(opts: RegisterOpts): Promise<SessionEntry> {
    const entry: SessionEntry = {
      id: opts.id,
      adapter: opts.adapter,
      transcriptPath: opts.transcriptPath,
      cwd: opts.cwd,
      tag: opts.tag,
      pid: opts.pid,
      lastSeen: new Date().toISOString(),
      status: "active",
    };
    await this.deps.registry.upsert(entry);
    return entry;
  }

  async tag(id: string, tag: string): Promise<void> {
    const e = await this.deps.registry.get(id);
    if (!e) throw new SessionNotFoundError(id);
    await this.deps.registry.upsert({ ...e, tag });
  }

  async untag(id: string): Promise<void> {
    const e = await this.deps.registry.get(id);
    if (!e) throw new SessionNotFoundError(id);
    const { tag, ...rest } = e;
    await this.deps.registry.upsert(rest);
  }

  async unregister(id: string): Promise<void> {
    await this.deps.registry.remove(id);
  }

  private async resolve(selector: string): Promise<SessionEntry> {
    const list = await this.deps.registry.list();
    const exact = list.find((e) => e.id === selector);
    if (exact) return exact;
    const tagMatches = list.filter((e) => e.tag === selector);
    if (tagMatches.length === 1) return tagMatches[0]!;
    if (tagMatches.length > 1) {
      throw new AmbiguousSelectorError(selector, tagMatches.map((e) => e.id));
    }
    const cwdMatches = list.filter((e) => e.cwd === selector);
    if (cwdMatches.length === 1) return cwdMatches[0]!;
    if (cwdMatches.length > 1) {
      throw new AmbiguousSelectorError(selector, cwdMatches.map((e) => e.id));
    }
    const cwdPrefix = list.filter((e) => e.cwd && e.cwd.startsWith(selector));
    if (cwdPrefix.length === 1) return cwdPrefix[0]!;
    if (cwdPrefix.length > 1) {
      throw new AmbiguousSelectorError(selector, cwdPrefix.map((e) => e.id));
    }
    throw new SessionNotFoundError(selector);
  }
}
