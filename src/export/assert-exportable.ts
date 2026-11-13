// The single enforcement point for ADR 0002 (docs/adr/0002-graph-and-network-retention.md).
//
// Every payload that leaves the machine -- a pushed post, claim or status, or a graph
// batch -- passes through `assertExportable` first. Each kind has a whitelist schema, and
// the schemas fail closed: a field the schema does not name is rejected whatever it is
// called, so `text`, `input`, `output` or `raw` never need to be listed to be refused.
//
// The schemas are a small hand-rolled combinator set rather than zod. zod's object
// schemas strip unknown keys by default, which is exactly the silent failure this module
// exists to prevent, and zod is not a direct dependency of this package.

import { hostname, userInfo } from "node:os";
import { NonExportableFieldError } from "../core/errors.js";
import {
  AUTHORED_BODY_MAX_TOKENS,
  DERIVED_BODY_MAX_TOKENS,
  EVIDENCE_MAX,
  POST_TYPES,
  TITLE_MAX_CHARS,
  estimateTokens,
} from "../feed/schema.js";

export const EXPORT_KINDS = ["post", "claim", "status", "graph"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/** Pushed structured status summaries are capped here (spec D1, D5). */
export const STATUS_SUMMARY_MAX_CHARS = 2_000;
/** A claim note is a short authored reason, not a body. */
export const CLAIM_NOTE_MAX_CHARS = 280;
/** Largest graph batch one request may carry (spec D5, `POST /v1/projects/{p}/graph`). */
export const GRAPH_BATCH_MAX_ROWS = 5_000;

// ---------------------------------------------------------------------------------------
// Schema combinators

interface Context {
  kind: ExportKind;
  /** This machine's `user@hostname`, the anonymous-author fallback that must never leave. */
  localIdentity: string | undefined;
}

/** Validates `value` found at JSON pointer `at` and returns it typed, or throws. */
type Schema<T> = (value: unknown, at: string, ctx: Context) => T;

interface Field<T, Optional extends boolean> {
  readonly schema: Schema<T>;
  readonly optional: Optional;
}
type AnyField = Field<unknown, boolean>;
type Shape = Record<string, AnyField>;
type FieldType<F> = F extends Field<infer T, boolean> ? T : never;
type RequiredKeys<S extends Shape> = { [K in keyof S]: S[K] extends Field<unknown, false> ? K : never }[keyof S];
type OptionalKeys<S extends Shape> = Exclude<keyof S, RequiredKeys<S>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type ObjectOf<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: FieldType<S[K]> } & { [K in OptionalKeys<S>]?: FieldType<S[K]> }
>;
type Infer<S> = S extends Schema<infer T> ? T : never;

function reject(ctx: Context, at: string, reason: string): never {
  throw new NonExportableFieldError(ctx.kind, at, reason);
}

/** RFC 6901 escaping, so a hostile key cannot forge a different pointer in the error. */
function child(at: string, key: string | number): string {
  return `${at}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const req = <T>(schema: Schema<T>): Field<T, false> => ({ schema, optional: false });
const opt = <T>(schema: Schema<T>): Field<T, true> => ({ schema, optional: true });

/**
 * A closed object. Keys whose value is `undefined` count as absent, because JSON
 * serialisation drops them and `validatePost` leaves several optional keys undefined.
 */
function obj<S extends Shape>(shape: S): Schema<ObjectOf<S>> {
  return (value, at, ctx) => {
    if (!isPlainObject(value)) reject(ctx, at, "must be an object");
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      if (!Object.hasOwn(shape, key)) reject(ctx, child(at, key), `is not in the ${ctx.kind} whitelist`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const fieldValue = value[key];
      if (fieldValue === undefined) {
        if (!field.optional) reject(ctx, child(at, key), "is required");
        continue;
      }
      out[key] = field.schema(fieldValue, child(at, key), ctx);
    }
    return out as ObjectOf<S>;
  };
}

function arr<T>(item: Schema<T>, bounds: { min?: number; max: number }): Schema<T[]> {
  return (value, at, ctx) => {
    if (!Array.isArray(value)) reject(ctx, at, "must be an array");
    const min = bounds.min ?? 0;
    if (value.length < min) reject(ctx, at, `must have at least ${min} item${min === 1 ? "" : "s"}`);
    if (value.length > bounds.max) reject(ctx, at, `has ${value.length} items; max is ${bounds.max}`);
    return value.map((entry, index) => item(entry, child(at, index), ctx));
  };
}

function oneOf<T extends string>(values: readonly T[]): Schema<T> {
  return (value, at, ctx) => {
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      reject(ctx, at, `must be one of: ${values.join(", ")}`);
    }
    return value as T;
  };
}

function literal<T extends string | number>(expected: T): Schema<T> {
  return (value, at, ctx) => {
    if (value !== expected) reject(ctx, at, `must be ${JSON.stringify(expected)}`);
    return expected;
  };
}

function num(bounds: { min: number; max: number; integer?: boolean }): Schema<number> {
  return (value, at, ctx) => {
    if (typeof value !== "number" || !Number.isFinite(value)) reject(ctx, at, "must be a finite number");
    if (bounds.integer && !Number.isInteger(value)) reject(ctx, at, "must be an integer");
    if (value < bounds.min || value > bounds.max) reject(ctx, at, `must be between ${bounds.min} and ${bounds.max}`);
    return value;
  };
}

function refine<T>(schema: Schema<T>, check: (value: T, at: string, ctx: Context) => void): Schema<T> {
  return (value, at, ctx) => {
    const parsed = schema(value, at, ctx);
    check(parsed, at, ctx);
    return parsed;
  };
}

// ---------------------------------------------------------------------------------------
// Strings: the never-leave rules for paths and hostnames live here

/**
 * A home-directory absolute path anywhere in a string: `/Users/<name>`, `/home/<name>`,
 * `/root`, `C:\Users\<name>`, including inside `file://` URLs. The leading class keeps a
 * repo-relative `src/home/x.ts` or `docs/Users/guide.md` from matching.
 */
const HOME_PATH = /(?:^|[^A-Za-z0-9._~-])(?:\/(?:Users|home)\/[^/\s]|\/root(?:\/|\b)|[A-Za-z]:[\\/]Users[\\/])/;
/** Any absolute or home-anchored path: POSIX root, `~`, a drive letter, or a UNC share. */
const ABSOLUTE = /^(?:\/|~|[A-Za-z]:[\\/]|\\\\)/;

export function containsHomePath(value: string): boolean {
  return HOME_PATH.test(value);
}

/** Repo-relative and POSIX: not absolute, no backslash, no NUL, no `..` segment. */
export function isRepoRelativePath(value: string): boolean {
  if (value.length === 0 || ABSOLUTE.test(value)) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  return !value.split("/").includes("..");
}

/**
 * - `text`: authored or derived free text. Only the home-path and hostname scans apply.
 * - `id`: identifiers and names. Must also not be an absolute path, which is how a
 *   machine-local project label or worktree path would otherwise slip out.
 * - `path`: a file path, which must be repo-relative.
 */
type StringRole = "text" | "id" | "path";

function str(rule: { role: StringRole; max: number; min?: number; pattern?: RegExp; patternHint?: string }): Schema<string> {
  return (value, at, ctx) => {
    if (typeof value !== "string") reject(ctx, at, "must be a string");
    const min = rule.min ?? 1;
    if (value.length < min) reject(ctx, at, "must not be empty");
    if (value.length > rule.max) reject(ctx, at, `is ${value.length} chars; max is ${rule.max}`);
    if (containsHomePath(value)) reject(ctx, at, "contains an absolute home-directory path");
    if (ctx.localIdentity && value.includes(ctx.localIdentity)) reject(ctx, at, "contains this machine's user@hostname");
    if (rule.role === "path" && !isRepoRelativePath(value)) {
      reject(ctx, at, "must be a repo-relative POSIX path (no leading / or ~, drive letter, backslash or ..)");
    }
    if (rule.role === "id" && ABSOLUTE.test(value)) reject(ctx, at, "is a machine-local absolute path");
    if (rule.pattern && !rule.pattern.test(value)) reject(ctx, at, `must match ${rule.patternHint ?? rule.pattern.source}`);
    return value;
  };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const timestamp: Schema<string> = (value, at, ctx) => {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    reject(ctx, at, "must be an ISO 8601 timestamp");
  }
  return value;
};

const recordId = str({ role: "id", max: 128, pattern: /^[A-Za-z0-9._:-]+$/, patternHint: "[A-Za-z0-9._:-]+" });
const sessionId = str({ role: "id", max: 256 });
const projectRef = str({ role: "id", max: 256 });
const adapterName = str({ role: "id", max: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/, patternHint: "an adapter name" });
const branchName = str({ role: "id", max: 255 });
const repoPath = str({ role: "path", max: 1024 });
const shortName = str({ role: "id", max: 120 });
const commitSha = str({ role: "id", max: 64, pattern: /^[0-9a-f]{7,64}$/, patternHint: "a hex commit sha" });

// ---------------------------------------------------------------------------------------
// post: a feed post as `FeedPost` (src/feed/schema.ts), minus every field that is local

const postEvidence = obj({
  kind: req(oneOf(["file", "commit", "session"] as const)),
  path: opt(repoPath),
  line: opt(num({ min: 1, max: Number.MAX_SAFE_INTEGER, integer: true })),
  ref: opt(str({ role: "id", max: 256 })),
  // `cursor` is deliberately absent: a terminal cursor carries the last scrollback line.
});

const postSchema = refine(
  obj({
    v: req(literal(1)),
    id: req(recordId),
    type: req(oneOf(POST_TYPES)),
    origin: req(oneOf(["authored", "derived"] as const)),
    // `anonymous` and `ambiguousSessions` are absent: an anonymous author's session is the
    // `user@hostname` fallback, and the ambiguous candidates are this machine's sessions.
    author: req(obj({ session: req(sessionId), adapter: opt(adapterName), name: opt(shortName) })),
    scope: req(obj({
      project: req(projectRef),
      worktree: opt(shortName),
      branch: opt(branchName),
      paths: req(arr(repoPath, { max: 256 })),
      topics: req(arr(str({ role: "id", max: 64 }), { max: 64 })),
    })),
    body: req(obj({
      title: req(str({ role: "text", max: TITLE_MAX_CHARS })),
      // The one free-text body field in any whitelist; the origin cap is checked below.
      text: req(str({ role: "text", max: AUTHORED_BODY_MAX_TOKENS * 4 })),
      evidence: req(arr(postEvidence, { max: EVIDENCE_MAX })),
    })),
    links: req(obj({
      replyTo: opt(recordId),
      supersedes: opt(recordId),
      mentions: req(arr(sessionId, { max: 64 })),
    })),
    lifecycle: req(obj({
      createdAt: req(timestamp),
      expiresAt: req(timestamp),
      validity: req(oneOf(["fresh", "drifted", "superseded", "expired"] as const)),
      driftedPaths: req(arr(repoPath, { max: 256 })),
      confidence: opt(num({ min: 0, max: 1 })),
    })),
  }),
  (post, at, ctx) => {
    const max = post.origin === "derived" ? DERIVED_BODY_MAX_TOKENS : AUTHORED_BODY_MAX_TOKENS;
    const tokens = estimateTokens(post.body.text);
    if (tokens > max) reject(ctx, child(child(at, "body"), "text"), `is ~${tokens} tokens; max for ${post.origin} posts is ${max}`);
  },
);

// ---------------------------------------------------------------------------------------
// claim: the per-project claim row (spec D2 v3). The principal is set by the server.

const claimSchema = obj({
  id: req(recordId),
  ownerSession: req(sessionId),
  ownerLabel: opt(shortName),
  createdAt: req(timestamp),
  expiresAt: req(timestamp),
  note: opt(str({ role: "text", max: CLAIM_NOTE_MAX_CHARS })),
  paths: req(arr(repoPath, { min: 1, max: 256 })),
});

// ---------------------------------------------------------------------------------------
// status: structured session status (spec D5, `PUT /v1/projects/{p}/status/{session}`)

const statusSchema = obj({
  session: opt(sessionId),
  label: req(str({ role: "text", max: 120 })),
  adapter: req(adapterName),
  branch: opt(branchName),
  state: req(oneOf(["active", "idle", "ended"] as const)),
  summary: req(str({ role: "text", min: 0, max: STATUS_SUMMARY_MAX_CHARS })),
  paths: req(arr(repoPath, { max: 256 })),
  updatedAt: req(timestamp),
});

// ---------------------------------------------------------------------------------------
// graph: a batch of node and edge rows (Research C §2 schema, camel-cased)

/** Node kinds that may leave. `worktree` is absent: its label is an absolute path. */
export const EXPORTABLE_NODE_KINDS = [
  "session", "agent", "project", "branch", "machine", "file", "commit", "toolcall", "skill", "post", "claim",
] as const;

/** The edge kinds 0.7 builds (spec D4). LLM-inferred kinds are absent. */
export const EXPORTABLE_EDGE_KINDS = [
  "SPAWNED", "RAN_AS", "IN_PROJECT", "ON_BRANCH", "RAN_ON", "CALLED", "INVOKED", "INVOKED_AMBIGUOUS",
  "CLAIMS", "OWNED_BY", "CHANGED", "SAME_AS",
  "AUTHORED", "ABOUT", "REPLIES_TO", "ANSWERS", "SUPERSEDES", "MENTIONS", "CITES",
  "READ", "WROTE", "COMMITTED",
  "OVERLAPS", "CO_CHANGES_WITH",
] as const;

/** `inferred` is reserved and rejected until a later ADR enables it (spec D4.7). */
export const EXPORTABLE_EDGE_ORIGINS = ["parsed", "heuristic", "authored", "derived"] as const;

/** Machine-scoped file nodes (`f:m:<machine>:<abs>`) hold an absolute path and never merge. */
const MACHINE_SCOPED_FILE = "f:m:";

const graphId = refine(str({ role: "id", max: 512 }), (id, at, ctx) => {
  if (id.startsWith(MACHINE_SCOPED_FILE)) reject(ctx, at, "is a machine-scoped file node, which never leaves the machine");
});

/** Each key is listed in ADR 0002; add one only with a reason recorded there. */
const graphProps = obj({
  adapter: opt(adapterName),
  branch: opt(branchName),
  candidates: opt(arr(str({ role: "id", max: 256 }), { max: 32 })),
  count: opt(num({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })),
  model: opt(str({ role: "id", max: 128 })),
  path: opt(repoPath),
  qualifier: opt(repoPath),
  resolution: opt(oneOf(["unique", "ambiguous"] as const)),
  sha: opt(commitSha),
  skill: opt(str({ role: "id", max: 256 })),
  tool: opt(str({ role: "id", max: 128 })),
  weight: opt(num({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE })),
});

const graphNode = refine(
  obj({
    id: req(graphId),
    kind: req(oneOf(EXPORTABLE_NODE_KINDS)),
    projectId: opt(projectRef),
    label: req(str({ role: "text", max: 256 })),
    props: opt(graphProps),
    firstSeen: req(timestamp),
    lastSeen: req(timestamp),
  }),
  (node, at, ctx) => {
    // A file's label is its path, so it must meet the path rule, not just the text rule.
    if (node.kind === "file") repoPath(node.label, child(at, "label"), ctx);
  },
);

const graphEdge = obj({
  id: req(graphId),
  kind: req(oneOf(EXPORTABLE_EDGE_KINDS)),
  src: req(graphId),
  dst: req(graphId),
  projectId: opt(projectRef),
  origin: req(oneOf(EXPORTABLE_EDGE_ORIGINS)),
  confidence: opt(num({ min: 0, max: 1 })),
  observedAt: req(timestamp),
  validFrom: opt(timestamp),
  validTo: opt(timestamp),
  invalidatedBy: opt(graphId),
  // Provenance is a pointer into the transcript (session, message range), never a copy.
  srcSession: opt(sessionId),
  srcMsgFrom: opt(num({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })),
  srcMsgTo: opt(num({ min: 0, max: Number.MAX_SAFE_INTEGER, integer: true })),
  props: opt(graphProps),
});

const graphBatchSchema = refine(
  obj({
    nodes: req(arr(graphNode, { max: GRAPH_BATCH_MAX_ROWS })),
    edges: req(arr(graphEdge, { max: GRAPH_BATCH_MAX_ROWS })),
  }),
  (batch, at, ctx) => {
    const rows = batch.nodes.length + batch.edges.length;
    if (rows > GRAPH_BATCH_MAX_ROWS) reject(ctx, at, `has ${rows} rows; max is ${GRAPH_BATCH_MAX_ROWS}`);
  },
);

// ---------------------------------------------------------------------------------------
// Envelopes and the public guard

const envelopes = {
  post: obj({ kind: req(literal("post")), post: req(postSchema) }),
  claim: obj({ kind: req(literal("claim")), claim: req(claimSchema) }),
  status: obj({ kind: req(literal("status")), status: req(statusSchema) }),
  graph: obj({ kind: req(literal("graph")), batch: req(graphBatchSchema) }),
} satisfies { [K in ExportKind]: Schema<{ kind: K }> };

export type ExportablePost = Infer<typeof postSchema>;
export type ExportableClaim = Infer<typeof claimSchema>;
export type ExportableStatus = Infer<typeof statusSchema>;
export type ExportableGraphNode = Infer<typeof graphNode>;
export type ExportableGraphEdge = Infer<typeof graphEdge>;
export type ExportableGraphBatch = Infer<typeof graphBatchSchema>;
export type ExportPayload = { [K in ExportKind]: Infer<(typeof envelopes)[K]> }[ExportKind];

function isExportKind(value: unknown): value is ExportKind {
  return typeof value === "string" && (EXPORT_KINDS as readonly string[]).includes(value);
}

/**
 * `user@hostname` is what `resolveAuthor` falls back to for an anonymous author. If the OS
 * cannot name the user (a uid with no passwd entry), that fallback cannot be produced
 * either, so there is no identity to guard against.
 */
function localIdentity(): string | undefined {
  let username: string;
  try {
    username = userInfo().username;
  } catch {
    return undefined;
  }
  return `${username}@${hostname()}`;
}

/**
 * Throws `NonExportableFieldError` unless `payload` is an envelope of one of the four
 * export kinds whose body fits that kind's whitelist (ADR 0002). Call it on every payload
 * before it is serialised for the network or written to an export.
 */
export function assertExportable(payload: unknown): asserts payload is ExportPayload {
  if (!isPlainObject(payload)) throw new NonExportableFieldError("payload", "", "must be an object with a kind");
  const kind = payload.kind;
  if (!isExportKind(kind)) {
    throw new NonExportableFieldError("payload", "/kind", `must be one of: ${EXPORT_KINDS.join(", ")}`);
  }
  envelopes[kind](payload, "", { kind, localIdentity: localIdentity() });
}
