// src/adapters/types.ts
import type { SessionEntry, RawMessage, Cursor } from "../core/types.js";

export interface AdapterReadResult {
  messages: RawMessage[];
  nextCursor: Cursor;
  eof: boolean;
}

export interface Adapter {
  /** Stable adapter name. Used as id prefix and registry key. */
  name: string;

  /** Discover sessions on disk. Returns SessionEntry[]; loader merges into registry. */
  scan(): Promise<SessionEntry[]>;

  /**
   * Read messages from `entry`, optionally starting from `cursor`.
   * MUST stop at last newline-terminated record (no partial-line parsing).
   * MUST never throw on a writer-mid-flight; treat partial trailing line as eof.
   */
  read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult>;

  /** Optional: live tail. Reserved for v2; not used in v1. */
  watch?(entry: SessionEntry, onChange: () => void): () => void;
}

export interface AdapterModule {
  default: Adapter;
}
