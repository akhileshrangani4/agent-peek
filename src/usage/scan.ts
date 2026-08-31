// src/usage/scan.ts
import { stat } from "node:fs/promises";
import type { Adapter } from "../adapters/types.js";
import type { SessionEntry } from "../core/types.js";
import { decodeCursor } from "../core/cursor.js";
import { extractorFor } from "./extract.js";
import type { UsageStore } from "./store.js";
import type { Invocation, Watermark } from "./schema.js";

export interface ScanResult {
  /** True when the index had never been scanned before this run. */
  bootstrap: boolean;
  sourcesScanned: number;
  sourcesSkipped: number;
  sourcesTombstoned: number;
  invocations: number;
  errors: { sourcePath: string; message: string }[];
}

export interface ScanOptions {
  /** Agent id for these sessions, where known. Orthogonal to the adapter name. */
  agentFor?: (entry: SessionEntry) => string | null;
  now?: Date;
}

/** Reads are chunked by the adapter; loop until it reports eof. */
const MAX_READ_ROUNDS = 10_000;

/**
 * Scan every session an adapter can discover and record its invocations.
 *
 * Sources come from `adapter.scan()`, not the registry: the registry is heavily stale
 * (1131 of 1749 entries pointed at deleted files when this was written) and scanning
 * the filesystem is the only view that is true right now.
 */
export async function scanAdapter(
  adapter: Adapter,
  store: UsageStore,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const now = opts.now ?? new Date();
  const result: ScanResult = {
    bootstrap: store.isEmpty(),
    sourcesScanned: 0,
    sourcesSkipped: 0,
    sourcesTombstoned: 0,
    invocations: 0,
    errors: [],
  };

  let entries: SessionEntry[];
  try {
    entries = await adapter.scan();
  } catch (err) {
    result.errors.push({ sourcePath: adapter.name, message: message(err) });
    return result;
  }

  for (const entry of entries) {
    // Terminal-backed sessions have no durable transcript to watermark.
    if (entry.sourceType === "terminal") { result.sourcesSkipped++; continue; }
    try {
      const scanned = await scanSource(adapter, entry, store, opts, now);
      if (scanned === null) { result.sourcesSkipped++; continue; }
      result.sourcesScanned++;
      result.invocations += scanned;
    } catch (err) {
      result.errors.push({ sourcePath: entry.transcriptPath, message: message(err) });
    }
  }

  // Anything watermarked for this adapter but no longer on disk becomes a tombstone:
  // proof the session was counted, as distinct from never having been observed.
  const live = new Set(entries.map((e) => e.transcriptPath));
  for (const w of watermarksFor(store, adapter.name)) {
    if (live.has(w.sourcePath) || w.deleted) continue;
    store.markDeleted(w.sourcePath, now);
    result.sourcesTombstoned++;
  }

  return result;
}

function watermarksFor(store: UsageStore, adapter: string): Watermark[] {
  const rows = store.handle()
    .prepare("SELECT source_path FROM watermarks WHERE adapter = ?")
    .all(adapter) as { source_path: string }[];
  return rows.map((r) => store.getWatermark(r.source_path)!).filter(Boolean);
}

/** Returns the number of invocations recorded, or null if the source was unchanged. */
async function scanSource(
  adapter: Adapter,
  entry: SessionEntry,
  store: UsageStore,
  opts: ScanOptions,
  now: Date,
): Promise<number | null> {
  const path = entry.transcriptPath;
  const st = await stat(path);
  const prior = store.getWatermark(path);

  // A shrink means truncation or rotation: the stored byte offset is now past EOF, so
  // re-scan from 0. Safe because the primary key makes the rewrite idempotent.
  const shrank = prior !== undefined && st.size < prior.size;
  const resume = shrank ? undefined : prior;

  if (!shrank && prior && st.size === prior.size && st.mtimeMs === prior.mtimeMs && !prior.deleted) {
    return null;
  }

  const extract = extractorFor(adapter.name);
  const agent = opts.agentFor?.(entry) ?? null;
  const sessionId = entry.id.includes(":") ? entry.id.slice(entry.id.indexOf(":") + 1) : entry.id;

  let cursor = resume?.cursor ?? undefined;
  let msgIndex = resume?.msgIndex ?? 0;
  const collected: Invocation[] = [];

  for (let round = 0; round < MAX_READ_ROUNDS; round++) {
    const read = await adapter.read(entry, cursor);
    if (read.messages.length > 0) {
      collected.push(...extract(read.messages, {
        sourcePath: path,
        adapter: adapter.name,
        agent,
        sessionId,
        cwd: entry.cwd ?? null,
        baseMsgIndex: msgIndex,
      }));
      msgIndex += read.messages.length;
    }
    cursor = read.nextCursor;
    if (read.eof || read.messages.length === 0) break;
  }

  const finalIndex = cursor ? safeMsgIndex(cursor, msgIndex) : msgIndex;

  // Rows and watermark in one transaction: a crash must not advance a watermark past
  // rows that were never written.
  store.recordSource(collected, {
    sourcePath: path,
    adapter: adapter.name,
    sessionId,
    cursor: cursor ?? null,
    msgIndex: finalIndex,
    size: st.size,
    mtimeMs: st.mtimeMs,
    scannedAt: now.toISOString(),
    deleted: false,
  }, { replace: shrank });

  return collected.length;
}

function safeMsgIndex(cursor: string, fallback: number): number {
  try {
    return decodeCursor(cursor).msgIndex;
  } catch {
    return fallback;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Scan every adapter into one store, merging the per-adapter results.
 *
 * The seam ticket 03 needs: without it a caller has to reach through
 * `createEngine().deps.loader` to obtain adapters one at a time. `bootstrap` is true
 * when the index had never been scanned, which is what `peek usage` should use to
 * decide whether to print the first-run message — the full parse of the corpus happens
 * once, and every scan after it is incremental.
 */
export async function scanAll(
  adapters: Adapter[],
  store: UsageStore,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const merged: ScanResult = {
    bootstrap: store.isEmpty(),
    sourcesScanned: 0,
    sourcesSkipped: 0,
    sourcesTombstoned: 0,
    invocations: 0,
    errors: [],
  };
  for (const adapter of adapters) {
    const result = await scanAdapter(adapter, store, opts);
    merged.sourcesScanned += result.sourcesScanned;
    merged.sourcesSkipped += result.sourcesSkipped;
    merged.sourcesTombstoned += result.sourcesTombstoned;
    merged.invocations += result.invocations;
    merged.errors.push(...result.errors);
  }
  return merged;
}
