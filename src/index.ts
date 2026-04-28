// src/index.ts
export const VERSION = "0.1.0";

export type {
  SessionEntry, SessionStatus, Activity,
  RawMessage, ToolCall,
  Cursor, CursorData,
  Snapshot, RawSnapshot, StructuredSnapshot, SummarySnapshot, SnapshotMode,
  PeekResult,
} from "./core/types.js";

export {
  SessionNotFoundError, AmbiguousSelectorError, AdapterError,
  AdapterNotFoundError, CursorMismatchError, RegistryLockTimeoutError,
  TranscriptUnreadableError, TranscriptCorruptError, SummaryUnavailableError,
} from "./core/errors.js";

export { Registry } from "./core/registry.js";
export { Engine } from "./core/engine.js";
export { encodeCursor, decodeCursor, cursorAdapter } from "./core/cursor.js";
export { toRaw, toStructured, toSummary } from "./core/snapshot.js";

export { AdapterLoader, discoverExternal } from "./adapters/loader.js";
export type { Adapter, AdapterReadResult, AdapterModule } from "./adapters/types.js";

import claudeCode from "./adapters/claude-code/index.js";
import codex from "./adapters/codex/index.js";
import { Engine } from "./core/engine.js";
import { Registry } from "./core/registry.js";
import { AdapterLoader, discoverExternal } from "./adapters/loader.js";

export interface CreateEngineOpts {
  home?: string;
  withBuiltins?: boolean;
  withExternal?: boolean;
}

export async function createEngine(opts: CreateEngineOpts = {}): Promise<Engine> {
  const registry = new Registry({ home: opts.home });
  const loader = new AdapterLoader();
  if (opts.withBuiltins !== false) {
    loader.register(claudeCode);
    if (codex && (codex as any).name) {
      try { loader.register(codex as any); } catch { /* may be stub */ }
    }
  }
  if (opts.withExternal) await discoverExternal(loader);
  return new Engine({ registry, loader });
}
