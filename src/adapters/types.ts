// src/adapters/types.ts
import type { SessionEntry, RawMessage, Cursor } from "../core/types.js";
import type { InvocationKind } from "../agents/types.js";

export interface AdapterReadResult {
  messages: RawMessage[];
  nextCursor: Cursor;
  eof: boolean;
}

export interface Adapter {
  /** Stable adapter name. Used as id prefix and registry key. */
  name: string;

  /**
   * Which kinds of skill invocation this parser can extract. Declared here because
   * seeing a slash command is a property of the parser, not of the agent: an adapter
   * that reads structured tool calls but has no slash syntax to extract leaves
   * human-initiated usage invisible, which is a different state from "never used".
   * Omitted means none, which is honest for an adapter that surfaces no tool calls.
   */
  observes?: InvocationKind[];

  /** Discover sessions on disk. Returns SessionEntry[]; loader merges into registry. */
  scan(): Promise<SessionEntry[]>;

  /**
   * Read messages from `entry`, optionally starting from `cursor`.
   * File-backed JSONL adapters must stop at the last newline-terminated record.
   * Adapters should avoid throwing on writer-mid-flight partial data.
   */
  read(entry: SessionEntry, cursor?: Cursor): Promise<AdapterReadResult>;

  /** Optional: live tail. Reserved for v2; not used in v1. */
  watch?(entry: SessionEntry, onChange: () => void): () => void;
}

export interface AdapterModule {
  default: Adapter;
}
