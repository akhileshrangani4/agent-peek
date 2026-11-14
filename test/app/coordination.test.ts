// test/app/coordination.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ClaimsStore } from "../../src/core/claims.js";
import type { CoordinationDigest } from "../../src/core/types.js";
import {
  COORDINATION_IDENTITY_FIELDS, CoordinationService, activeFileConflicts, isIgnoredSession,
  parseCoordinationFields, projectCoordinationDigest, projectCoordinationSession,
} from "../../src/app/coordination.js";
import { makeTmpHome, withEnv } from "../helpers/tmp-home.js";
import { fakeAdapter, fixtureEngine, userTurn } from "./fixtures.js";

type DigestSession = CoordinationDigest["sessions"][number];

/** Only the fields the conflict rule reads; the rest of a digest row is irrelevant here. */
function writer(overrides: Partial<DigestSession> & { id: string }): DigestSession {
  return {
    displayName: overrides.id,
    adapter: "fake",
    status: "active",
    activeWritingFiles: ["/repo/a.ts"],
    writingFileEvents: [{ file: "/repo/a.ts", active: true, lastWritingAt: "2026-11-13T12:00:00.000Z" }],
    ...overrides,
  } as unknown as DigestSession;
}

function digestOf(sessions: DigestSession[]): CoordinationDigest {
  return { sessions, overlapHints: [], nextCursor: "cursor" } as unknown as CoordinationDigest;
}

describe("conflict rules", () => {
  it("ignores a session by id, by display name, or through its parent", () => {
    const ignored = new Set(["fake:lead", "reviewer"]);
    expect(isIgnoredSession({ id: "fake:x", displayName: "x" }, new Set())).toBe(false);
    expect(isIgnoredSession({ id: "fake:lead", displayName: "lead" }, ignored)).toBe(true);
    expect(isIgnoredSession({ id: "fake:r", displayName: "reviewer" }, ignored)).toBe(true);
    expect(isIgnoredSession({ id: "fake:sub", displayName: "sub", parentSessionId: "fake:lead" }, ignored)).toBe(true);
    expect(isIgnoredSession({ id: "fake:other", displayName: "other" }, ignored)).toBe(false);
  });

  it("reports active writers of the target, with when they last wrote", () => {
    const digest = digestOf([
      writer({ id: "fake:a", currentTask: "fix a" }),
      writer({ id: "fake:b", activeWritingFiles: ["/repo/b.ts"] }),
    ]);
    expect(activeFileConflicts(digest, "/repo/a.ts")).toEqual([{
      id: "fake:a", displayName: "fake:a", adapter: "fake", status: "active",
      currentTask: "fix a", lastWritingAt: "2026-11-13T12:00:00.000Z",
    }]);
  });

  it("leaves out your own claims, matched on display owner or creator", () => {
    const digest = digestOf([
      writer({ id: "claim:1", adapter: "claim", displayName: "claim-me" }),
      writer({ id: "claim:2", adapter: "claim", displayName: "claim-reviewer", creator: "me" }),
      writer({ id: "claim:3", adapter: "claim", displayName: "claim-them", creator: "them" }),
    ]);
    expect(activeFileConflicts(digest, "/repo/a.ts", "me").map((c) => c.id)).toEqual(["claim:3"]);
    expect(activeFileConflicts(digest, "/repo/a.ts").map((c) => c.id)).toEqual(["claim:1", "claim:2", "claim:3"]);
    expect(activeFileConflicts(digest, "/repo/a.ts", "them")[1]).toMatchObject({ id: "claim:2", creator: "me" });
  });

  it("leaves out ignored sessions and their subagents", () => {
    const digest = digestOf([
      writer({ id: "fake:lead" }),
      writer({ id: "fake:sub", parentSessionId: "fake:lead" }),
      writer({ id: "fake:other" }),
    ]);
    expect(activeFileConflicts(digest, "/repo/a.ts", undefined, new Set(["fake:lead"])).map((c) => c.id)).toEqual(["fake:other"]);
  });
});

describe("coordination field projection", () => {
  it("adds the identity fields to a valid list", () => {
    expect(parseCoordinationFields("currentTask, activeWritingFiles,currentTask")).toEqual({
      ok: true,
      fields: [...COORDINATION_IDENTITY_FIELDS, "currentTask", "activeWritingFiles"],
    });
  });

  it("refuses unknown and empty lists", () => {
    expect(parseCoordinationFields("currentTask,secrets")).toEqual({ ok: false, invalid: ["secrets"] });
    expect(parseCoordinationFields(" , ")).toEqual({ ok: false, invalid: [] });
  });

  it("keeps only the requested fields that are present", () => {
    const session = writer({ id: "fake:a", currentTask: undefined });
    expect(projectCoordinationSession(session, ["id", "currentTask", "activeWritingFiles"]))
      .toEqual({ id: "fake:a", activeWritingFiles: ["/repo/a.ts"] });
  });

  it("projects a digest, drops a delivered cursor and says where it went", () => {
    const digest = digestOf([writer({ id: "fake:a" })]);
    expect(projectCoordinationDigest(digest, {})).toEqual({ ...digest });
    const projected = projectCoordinationDigest(digest, { fields: ["id"], omitCursor: true, cursorLocation: "/tmp/cursor" });
    expect(projected).toEqual({ sessions: [{ id: "fake:a" }], overlapHints: [], cursorFile: "/tmp/cursor" });
  });
});

describe("CoordinationService", () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let repo: string;
  let service: CoordinationService;

  beforeEach(async () => {
    ({ home, cleanup } = await makeTmpHome());
    repo = join(home, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "a.ts"), "");
    service = new CoordinationService(fixtureEngine(home, [fakeAdapter([
      { id: "lead", cwd: repo, messages: [userTurn("ship the fix")] },
    ])]));
  });
  afterEach(async () => { await cleanup(); });

  const noHarnessSession = { CLAUDE_SESSION_ID: "" };

  it("resolves your own identity from the session in your directory", async () => {
    await withEnv(noHarnessSession, async () => {
      expect(await service.identity({ cwd: repo })).toEqual({ ignoredOwner: "fake:lead", ignoredSessions: [] });
      expect(await service.identity({ cwd: repo, ignoreSelf: true, ignoreSession: "reviewer" }))
        .toEqual({ ignoredOwner: "fake:lead", ignoredSessions: ["reviewer", "fake:lead"] });
    });
  });

  it("lets --as win over the resolved self, and --include-self drop it", async () => {
    await withEnv(noHarnessSession, async () => {
      expect(await service.identity({ cwd: repo, as: "reviewer" })).toEqual({ ignoredOwner: "reviewer", ignoredSessions: [] });
      expect(await service.identity({ cwd: repo, includeSelf: true })).toEqual({ ignoredSessions: [] });
      expect(await service.identity({ cwd: repo, includeSelf: true, ignoreSelf: true }))
        .toEqual({ ignoredSessions: ["fake:lead"] });
    });
  });

  it("says why when it has to guess who you are", async () => {
    await withEnv(noHarnessSession, async () => {
      const elsewhere = join(home, "elsewhere");
      const identity = await service.identity({ cwd: elsewhere });
      expect(identity.ignoredOwner).toMatch(new RegExp(`@.+:${elsewhere}$`));
      expect(identity.ownerNote).toMatch(/^no tracked session found for this directory/);
    });
  });

  it("reports another owner's claim as a conflict and your own as clear", async () => {
    const target = join(repo, "a.ts");
    await new ClaimsStore({ home }).claim({ files: [target], owner: "them", cwd: repo, ttlMs: 60_000 });
    const conflicted = await service.check({ cwd: repo, targets: [target], identity: { ignoredSessions: [] } });
    expect(conflicted.ok).toBe(false);
    expect(conflicted.conflictCount).toBe(1);
    expect(conflicted.files[0]!.conflicts[0]).toMatchObject({ adapter: "claim", displayName: "claim-them" });

    const mine = await service.check({ cwd: repo, targets: [target], identity: { ignoredOwner: "them", ignoredSessions: [] } });
    expect(mine).toEqual({ ok: true, files: [{ file: target, conflicts: [] }], conflictCount: 0 });
  });

  it("serves the digest for a directory", async () => {
    await new ClaimsStore({ home }).claim({ files: [join(repo, "a.ts")], owner: "them", cwd: repo, ttlMs: 60_000 });
    const digest = await service.digest({ cwd: repo });
    expect(digest.sessions.map((s) => s.adapter)).toContain("claim");
    expect(typeof digest.nextCursor).toBe("string");
  });
});
