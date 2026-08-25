// src/index.ts
import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;

export type {
  SessionEntry, SessionStatus, Activity, FileClaim,
  RawMessage, ToolCall,
  Cursor, CursorData,
  Snapshot, RawSnapshot, StructuredSnapshot, BriefSnapshot, SummarySnapshot, HandoffSnapshot,
  SnapshotMode, RawWindowFrom, RawOrder,
  PeekResult,
  CoordinationCursor, CoordinationSession, CoordinationOverlap, CoordinationDigest,
} from "./core/types.js";

export {
  SessionNotFoundError, AmbiguousSelectorError, AdapterError,
  AdapterNotFoundError, CursorMismatchError, InvalidCursorError, RegistryLockTimeoutError,
  TranscriptUnreadableError, TranscriptCorruptError, SummaryUnavailableError,
  PostRejectedError, PostNotFoundError, NotAProjectError,
} from "./core/errors.js";

export { Registry } from "./core/registry.js";
export { ClaimsStore } from "./core/claims.js";
export { Engine } from "./core/engine.js";
export { encodeCursor, decodeCursor, cursorAdapter } from "./core/cursor.js";
export { toRaw, toStructured, toBrief, toHandoff, toSummary } from "./core/snapshot.js";
export {
  encodeCoordinationCursor, decodeCoordinationCursor,
  buildCoordinationDigest, buildCoordinationSession,
} from "./core/coordination.js";

export {
  postToFeed, readFeed, expandPost, feedStats,
  validatePost, estimateTokens, DEFAULT_TTL_MS,
  FeedStore, feedDbPath, projectIdentity, resolveAuthor,
} from "./feed/index.js";
export type {
  FeedPost, PostInput, PostType, PostAuthor, PostEvidence, PostOrigin, PostValidity,
  PackedItem, PackedFeed, RankContext, FeedReadResult,
} from "./feed/index.js";

export { AdapterLoader, discoverExternal } from "./adapters/loader.js";
export type { Adapter, AdapterReadResult, AdapterModule } from "./adapters/types.js";

import claudeCode from "./adapters/claude-code/index.js";
import codex from "./adapters/codex/index.js";
import copilotCli from "./adapters/copilot-cli/index.js";
import gemini from "./adapters/gemini/index.js";
import goose from "./adapters/goose/index.js";
import opencode from "./adapters/opencode/index.js";
import screen from "./adapters/screen/index.js";
import tmux from "./adapters/tmux/index.js";
import { Engine } from "./core/engine.js";
import { Registry } from "./core/registry.js";
import { ClaimsStore } from "./core/claims.js";
import { AdapterLoader, discoverExternal } from "./adapters/loader.js";

export interface CreateEngineOpts {
  home?: string;
  withBuiltins?: boolean;
  withExternal?: boolean;
}

export async function createEngine(opts: CreateEngineOpts = {}): Promise<Engine> {
  const registry = new Registry({ home: opts.home });
  const claims = new ClaimsStore({ home: opts.home });
  const loader = new AdapterLoader();
  if (opts.withBuiltins !== false) {
    loader.register(claudeCode);
    loader.register(codex);
    loader.register(copilotCli);
    loader.register(gemini);
    loader.register(goose);
    loader.register(opencode);
    loader.register(screen);
    loader.register(tmux);
  }
  if (opts.withExternal) await discoverExternal(loader);
  return new Engine({ registry, loader, claims });
}
