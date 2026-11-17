import { hostname, userInfo } from "node:os";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  assertExportable,
  containsHomePath,
  isRepoRelativePath,
  GRAPH_BATCH_MAX_ROWS,
  STATUS_SUMMARY_MAX_CHARS,
  type ExportPayload,
  type ExportablePost,
} from "../../src/export/assert-exportable.js";
import { NonExportableFieldError } from "../../src/core/errors.js";
import { validatePost } from "../../src/feed/schema.js";
import * as library from "../../src/index.js";

/** Runs the guard and returns the error it threw, failing the test if it did not throw. */
function rejection(payload: unknown): NonExportableFieldError {
  try {
    assertExportable(payload);
  } catch (error) {
    expect(error).toBeInstanceOf(NonExportableFieldError);
    return error as NonExportableFieldError;
  }
  throw new Error("expected assertExportable to throw NonExportableFieldError");
}

/** A deep copy with one change applied, so every case starts from a payload that passes. */
function mutate<T>(value: T, change: (draft: T) => void): T {
  const draft = structuredClone(value);
  change(draft);
  return draft;
}

const NOW = new Date("2026-11-13T12:00:00.000Z");
const LOCAL_IDENTITY = `${userInfo().username}@${hostname()}`;

function validPost(): ExportablePost {
  return {
    v: 1,
    id: "0mhx2abcd-1a2b3c4d",
    type: "finding",
    origin: "authored",
    author: { session: "claude-code:7f1c", adapter: "claude-code", name: "auth-refactor" },
    scope: { project: "gh:acme/api", branch: "feat/auth", paths: ["src/auth/verify.ts"], topics: ["auth"] },
    body: {
      title: "Webhook verification moved into middleware",
      text: "Dedup lives in verify.ts now; do not re-add the handler-level check.",
      evidence: [{ kind: "file", path: "src/auth/verify.ts", line: 12 }, { kind: "commit", ref: "a1b2c3d" }],
    },
    links: { replyTo: "0mhx1zzzz-00000000", mentions: ["codex:42"] },
    lifecycle: {
      createdAt: "2026-11-13T12:00:00.000Z",
      expiresAt: "2026-12-13T12:00:00.000Z",
      validity: "fresh",
      driftedPaths: [],
      confidence: 0.8,
    },
  };
}

const validClaim = {
  id: "clm-6b2f",
  ownerSession: "s:2c9e:claude-code:7f1c",
  ownerLabel: "auth-refactor",
  createdAt: "2026-11-13T12:00:00.000Z",
  expiresAt: "2026-11-13T14:00:00.000Z",
  note: "rewriting token refresh",
  paths: ["src/auth/refresh.ts", "src/auth/session.ts"],
};

const validStatus = {
  session: "s:2c9e:claude-code:7f1c",
  label: "auth-refactor",
  adapter: "claude-code",
  branch: "feat/auth",
  state: "active",
  summary: "Moving refresh-token rotation into the session service.",
  paths: ["src/auth/refresh.ts"],
  updatedAt: "2026-11-13T12:05:00Z",
};

const validBatch = {
  nodes: [
    { id: "p:4f2a", kind: "project", label: "gh:acme/api", firstSeen: "2026-11-13T12:00:00Z", lastSeen: "2026-11-13T12:00:00Z" },
    { id: "s:2c9e:claude-code:7f1c", kind: "session", projectId: "p:4f2a", label: "auth-refactor", props: { adapter: "claude-code", model: "claude-opus-4" }, firstSeen: "2026-11-13T12:00:00Z", lastSeen: "2026-11-13T12:30:00Z" },
    { id: "f:p:4f2a:src/auth/verify.ts", kind: "file", projectId: "p:4f2a", label: "src/auth/verify.ts", firstSeen: "2026-11-13T12:00:00Z", lastSeen: "2026-11-13T12:30:00Z" },
    { id: "c:p:4f2a:a1b2c3d", kind: "commit", projectId: "p:4f2a", label: "a1b2c3d", props: { sha: "a1b2c3d" }, firstSeen: "2026-11-13T12:20:00Z", lastSeen: "2026-11-13T12:20:00Z" },
  ],
  edges: [
    {
      id: "e:wrote:1", kind: "WROTE", src: "s:2c9e:claude-code:7f1c", dst: "f:p:4f2a:src/auth/verify.ts", projectId: "p:4f2a",
      origin: "heuristic", observedAt: "2026-11-13T12:10:00Z", srcSession: "s:2c9e:claude-code:7f1c", srcMsgFrom: 14, srcMsgTo: 15,
      props: { branch: "feat/auth", tool: "Edit" },
    },
    {
      id: "e:committed:1", kind: "COMMITTED", src: "s:2c9e:claude-code:7f1c", dst: "c:p:4f2a:a1b2c3d", origin: "heuristic",
      observedAt: "2026-11-13T12:20:00Z", validFrom: "2026-11-13T12:20:00Z",
    },
    {
      id: "e:changed:1", kind: "CHANGED", src: "c:p:4f2a:a1b2c3d", dst: "f:p:4f2a:src/auth/verify.ts", origin: "parsed",
      observedAt: "2026-11-13T12:21:00Z", props: { count: 1, path: "src/auth/verify.ts" },
    },
  ],
};

describe("assertExportable: post", () => {
  const payload = () => ({ kind: "post" as const, post: validPost() });

  it("accepts a whitelisted post", () => {
    expect(() => assertExportable(payload())).not.toThrow();
  });

  it("accepts the FeedPost that validatePost builds, including its undefined optional keys", () => {
    const post = validatePost({
      type: "warning",
      title: "Do not touch the migration lock",
      text: "Two sessions are editing the same migration; coordinate first.",
      project: "gh:acme/api",
      author: { session: "codex:42", adapter: "codex" },
      paths: ["db/migrations/0007.sql"],
    }, NOW);
    expect(post.scope.worktree).toBeUndefined();
    expect(() => assertExportable({ kind: "post", post })).not.toThrow();
  });

  it("rejects a field outside the whitelist, naming it by pointer", () => {
    const error = rejection(mutate(payload(), (d) => Object.assign(d.post, { principal: "spoofed" })));
    expect(error.pointer).toBe("/post/principal");
    expect(error.kind).toBe("post");
    expect(error.reason).toMatch(/not in the post whitelist/);
  });

  it("rejects transcript-shaped fields: text outside the body, tool input, raw records", () => {
    expect(rejection(mutate(payload(), (d) => Object.assign(d.post, { text: "user: please refactor" }))).pointer).toBe("/post/text");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.post.author, { text: "x" }))).pointer).toBe("/post/author/text");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.post.body, { input: { command: "ls" } }))).pointer).toBe("/post/body/input");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.post.body.evidence[0]!, { raw: {} }))).pointer).toBe("/post/body/evidence/0/raw");
  });

  it("rejects an evidence cursor, which can carry terminal scrollback", () => {
    const error = rejection(mutate(payload(), (d) => Object.assign(d.post.body.evidence[0]!, { cursor: "eyJ0YWlsIjoiJCBscyJ9" })));
    expect(error.pointer).toBe("/post/body/evidence/0/cursor");
  });

  it("rejects absolute /Users/… paths in path fields and in authored text", () => {
    expect(rejection(mutate(payload(), (d) => { d.post.scope.paths = ["/Users/alice/acme/api/src/auth/verify.ts"]; })).pointer).toBe("/post/scope/paths/0");
    expect(rejection(mutate(payload(), (d) => { d.post.body.text = "See /Users/alice/acme/api/src/auth/verify.ts for the fix."; })).pointer).toBe("/post/body/text");
    expect(rejection(mutate(payload(), (d) => { d.post.lifecycle.driftedPaths = ["../outside.ts"]; })).pointer).toBe("/post/lifecycle/driftedPaths/0");
  });

  it("rejects a machine-local project label and an absolute worktree", () => {
    expect(rejection(mutate(payload(), (d) => { d.post.scope.project = "/srv/checkouts/api/.git"; })).pointer).toBe("/post/scope/project");
    expect(rejection(mutate(payload(), (d) => { d.post.scope.worktree = "/tmp/wt-1"; })).pointer).toBe("/post/scope/worktree");
  });

  it("rejects the anonymous user@hostname fallback author", () => {
    const anonymous = mutate(payload(), (d) => { d.post.author = { session: LOCAL_IDENTITY, anonymous: true } as typeof d.post.author; });
    expect(rejection(anonymous).pointer).toBe("/post/author/anonymous");
    const stripped = mutate(payload(), (d) => { d.post.author = { session: LOCAL_IDENTITY }; });
    expect(rejection(stripped).reason).toMatch(/user@hostname/);
  });

  it("caps the body at the origin's token limit", () => {
    const derived = mutate(payload(), (d) => { d.post.origin = "derived"; d.post.body.text = "x".repeat(200); });
    expect(rejection(derived).pointer).toBe("/post/body/text");
    const authored = mutate(payload(), (d) => { d.post.body.text = "x".repeat(200); });
    expect(() => assertExportable(authored)).not.toThrow();
  });

  it("never echoes the rejected value in the error message", () => {
    const secret = "/Users/alice/.ssh/id_ed25519";
    const error = rejection(mutate(payload(), (d) => { d.post.body.text = `key at ${secret}`; }));
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("alice");
  });
});

describe("assertExportable: claim", () => {
  const payload = () => ({ kind: "claim" as const, claim: structuredClone(validClaim) });

  it("accepts a whitelisted claim", () => {
    expect(() => assertExportable(payload())).not.toThrow();
  });

  it("rejects a field outside the whitelist, including a client-asserted principal", () => {
    expect(rejection(mutate(payload(), (d) => Object.assign(d.claim, { ownerPrincipal: "admin" }))).pointer).toBe("/claim/ownerPrincipal");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.claim, { cwd: "src" }))).pointer).toBe("/claim/cwd");
  });

  it("rejects text and input fields", () => {
    expect(rejection(mutate(payload(), (d) => Object.assign(d.claim, { text: "x" }))).pointer).toBe("/claim/text");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.claim, { input: "x" }))).pointer).toBe("/claim/input");
  });

  it("rejects absolute paths: the 0.6 claims.json shape does not export as-is", () => {
    expect(rejection(mutate(payload(), (d) => { d.claim.paths = ["/Users/alice/acme/api/src/auth/refresh.ts"]; })).pointer).toBe("/claim/paths/0");
    expect(rejection(mutate(payload(), (d) => { d.claim.paths = ["C:\\Users\\alice\\api\\x.ts"]; })).pointer).toBe("/claim/paths/0");
    expect(rejection(mutate(payload(), (d) => { d.claim.note = "mirrors /home/bob/api"; })).pointer).toBe("/claim/note");
  });

  it("requires at least one path and a valid expiry", () => {
    expect(rejection(mutate(payload(), (d) => { d.claim.paths = []; })).pointer).toBe("/claim/paths");
    expect(rejection(mutate(payload(), (d) => { d.claim.expiresAt = "tomorrow"; })).pointer).toBe("/claim/expiresAt");
  });
});

describe("assertExportable: status", () => {
  const payload = () => ({ kind: "status" as const, status: structuredClone(validStatus) });

  it("accepts a whitelisted status, with or without a session key", () => {
    expect(() => assertExportable(payload())).not.toThrow();
    expect(() => assertExportable(mutate(payload(), (d) => { delete (d.status as Partial<typeof validStatus>).session; }))).not.toThrow();
  });

  it("rejects a field outside the whitelist", () => {
    expect(rejection(mutate(payload(), (d) => Object.assign(d.status, { cwd: "api" }))).pointer).toBe("/status/cwd");
  });

  it("rejects the transcript fields a sidecar might be tempted to send", () => {
    expect(rejection(mutate(payload(), (d) => Object.assign(d.status, { text: "assistant: done" }))).pointer).toBe("/status/text");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.status, { input: { file_path: "a" } }))).pointer).toBe("/status/input");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.status, { lastMessage: "x" }))).pointer).toBe("/status/lastMessage");
  });

  it("caps the summary at 2,000 chars and rejects home paths inside it", () => {
    const max = mutate(payload(), (d) => { d.status.summary = "x".repeat(STATUS_SUMMARY_MAX_CHARS); });
    expect(() => assertExportable(max)).not.toThrow();
    expect(rejection(mutate(payload(), (d) => { d.status.summary = "x".repeat(STATUS_SUMMARY_MAX_CHARS + 1); })).pointer).toBe("/status/summary");
    expect(rejection(mutate(payload(), (d) => { d.status.summary = "editing /Users/alice/api/a.ts"; })).pointer).toBe("/status/summary");
  });

  it("rejects an unknown state and absolute paths", () => {
    expect(rejection(mutate(payload(), (d) => { d.status.state = "writing"; })).pointer).toBe("/status/state");
    expect(rejection(mutate(payload(), (d) => { d.status.paths = ["/Users/alice/api/a.ts"]; })).pointer).toBe("/status/paths/0");
  });
});

describe("assertExportable: graph batch", () => {
  const payload = () => ({ kind: "graph" as const, batch: structuredClone(validBatch) });

  it("accepts a whitelisted batch", () => {
    expect(() => assertExportable(payload())).not.toThrow();
  });

  it("rejects a field outside the node, edge or props whitelist", () => {
    expect(rejection(mutate(payload(), (d) => Object.assign(d.batch.nodes[0]!, { summary: "x" }))).pointer).toBe("/batch/nodes/0/summary");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.batch.edges[0]!, { output: "x" }))).pointer).toBe("/batch/edges/0/output");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.batch.edges[0]!.props!, { command: "rm -rf" }))).pointer).toBe("/batch/edges/0/props/command");
  });

  it("rejects message text and tool input wherever they appear", () => {
    expect(rejection(mutate(payload(), (d) => Object.assign(d.batch.nodes[1]!.props!, { text: "hello" }))).pointer).toBe("/batch/nodes/1/props/text");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.batch.edges[0]!.props!, { input: { file_path: "a" } }))).pointer).toBe("/batch/edges/0/props/input");
    expect(rejection(mutate(payload(), (d) => Object.assign(d.batch, { msgFts: [] }))).pointer).toBe("/batch/msgFts");
  });

  it("rejects absolute /Users/… paths in labels, ids and props", () => {
    expect(rejection(mutate(payload(), (d) => { d.batch.nodes[2]!.label = "/Users/alice/api/src/auth/verify.ts"; })).pointer).toBe("/batch/nodes/2/label");
    expect(rejection(mutate(payload(), (d) => { d.batch.nodes[2]!.label = "../verify.ts"; })).pointer).toBe("/batch/nodes/2/label");
    expect(rejection(mutate(payload(), (d) => { d.batch.edges[0]!.dst = "f:p:4f2a:/Users/alice/x.ts"; })).pointer).toBe("/batch/edges/0/dst");
    expect(rejection(mutate(payload(), (d) => { d.batch.edges[2]!.props!.path = "/opt/api/x.ts"; })).pointer).toBe("/batch/edges/2/props/path");
  });

  it("rejects machine-scoped file nodes and edges that point at them", () => {
    expect(rejection(mutate(payload(), (d) => { d.batch.nodes[2]!.id = "f:m:2c9e:etc/hosts"; })).pointer).toBe("/batch/nodes/2/id");
    expect(rejection(mutate(payload(), (d) => { d.batch.edges[0]!.dst = "f:m:2c9e:etc/hosts"; })).pointer).toBe("/batch/edges/0/dst");
  });

  it("rejects inferred edges and kinds outside the 0.7 set", () => {
    expect(rejection(mutate(payload(), (d) => { d.batch.edges[0]!.origin = "inferred"; })).pointer).toBe("/batch/edges/0/origin");
    expect(rejection(mutate(payload(), (d) => { d.batch.edges[0]!.kind = "DECIDED"; })).pointer).toBe("/batch/edges/0/kind");
    expect(rejection(mutate(payload(), (d) => { d.batch.nodes[0]!.kind = "worktree"; })).pointer).toBe("/batch/nodes/0/kind");
  });

  it("caps a batch at the server's row limit", () => {
    const edge = validBatch.edges[1]!;
    const tooMany = { kind: "graph", batch: { nodes: validBatch.nodes, edges: Array.from({ length: GRAPH_BATCH_MAX_ROWS }, (_, i) => ({ ...edge, id: `e:${i}` })) } };
    expect(rejection(tooMany).pointer).toBe("/batch");
  });
});

describe("assertExportable: envelope", () => {
  it("rejects non-objects, unknown kinds and stray envelope keys", () => {
    expect(rejection(null).pointer).toBe("");
    expect(rejection("post").pointer).toBe("");
    expect(rejection({ kind: "transcript", messages: [] }).pointer).toBe("/kind");
    expect(rejection({ kind: "status", status: validStatus, text: "x" }).pointer).toBe("/text");
    expect(rejection({ kind: "status" }).pointer).toBe("/status");
  });

  it("rejects class instances and arrays where objects are expected", () => {
    expect(rejection({ kind: "status", status: new Map() }).pointer).toBe("/status");
    expect(rejection({ kind: "graph", batch: { nodes: {}, edges: [] } }).pointer).toBe("/batch/nodes");
  });

  it("escapes hostile keys so the pointer cannot be forged", () => {
    expect(rejection({ kind: "status", status: { ...validStatus, "a/b~c": 1 } }).pointer).toBe("/status/a~1b~0c");
  });

  it("rejects a __proto__ key parsed from JSON", () => {
    const parsed: unknown = JSON.parse(`{"kind":"claim","claim":${JSON.stringify(validClaim).slice(0, -1)},"__proto__":{"text":"x"}}}`);
    expect(rejection(parsed).pointer).toBe("/claim/__proto__");
  });

  it("narrows the payload type and is exported from the package root", () => {
    const value: unknown = { kind: "claim", claim: validClaim };
    assertExportable(value);
    expectTypeOf(value).toEqualTypeOf<ExportPayload>();
    expect(library.assertExportable).toBe(assertExportable);
    expect(library.NonExportableFieldError).toBe(NonExportableFieldError);
  });
});

describe("path helpers", () => {
  it("isRepoRelativePath accepts POSIX repo paths only", () => {
    for (const ok of ["src/a.ts", "a", ".github/workflows/ci.yml", "docs/Users/guide.md"]) expect(isRepoRelativePath(ok)).toBe(true);
    for (const bad of ["", "/abs", "~/x", "C:\\x", "C:/x", "\\\\share\\x", "a\\b", "a/../b", "..", "a\0b"]) expect(isRepoRelativePath(bad)).toBe(false);
  });

  it("containsHomePath finds home directories anywhere but not inside repo paths", () => {
    for (const hit of ["/Users/a/x", "see /home/bob/x", "file:///Users/a", "/root/.bashrc", "/root", "C:\\Users\\a", "(/home/c/d)"]) {
      expect(containsHomePath(hit)).toBe(true);
    }
    for (const miss of ["src/home/x.ts", "docs/Users/guide.md", "/rootfs/x", "/Users/", "home/a"]) expect(containsHomePath(miss)).toBe(false);
  });
});
