// test/app/claims.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaimsStore } from "../../src/core/claims.js";
import { ClaimsService } from "../../src/app/claims.js";
import { fixedClock } from "../../src/app/time.js";
import { makeTmpHome } from "../helpers/tmp-home.js";

const NOW = "2026-11-13T12:00:00.000Z";

describe("ClaimsService", () => {
  let home: string;
  let cleanup: () => Promise<void>;
  let claims: ClaimsService;

  beforeEach(async () => {
    ({ home, cleanup } = await makeTmpHome());
    claims = new ClaimsService({ store: new ClaimsStore({ home }), clock: fixedClock(NOW) });
  });
  afterEach(async () => { await cleanup(); });

  const self = { owner: "claude-code:me", session: "claude-code:me" };

  it("resolves files against the caller's directory and stamps the claim with the clock", async () => {
    const claim = await claims.claim({ cwd: "/repo", files: ["src/b.ts", "src/a.ts", "/repo/src/a.ts"], self, ttlMs: 60_000 });
    expect(claim.files).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
    expect(claim.owner).toBe("claude-code:me");
    // The store records a creator only when it differs from the owner.
    expect(claim).not.toHaveProperty("creator");
    expect(claim.cwd).toBe("/repo");
    expect(claim.createdAt).toBe(NOW);
    expect(claim.expiresAt).toBe("2026-11-13T12:01:00.000Z");
    expect(claim).not.toHaveProperty("identityNote");
  });

  it("shows a display owner while keeping the claimer as creator", async () => {
    const claim = await claims.claim({ cwd: "/repo", files: ["x.ts"], self, as: "reviewer", ttlMs: 60_000 });
    expect(claim.owner).toBe("reviewer");
    expect(claim.creator).toBe("claude-code:me");
  });

  it("carries the identity note only when peek had to guess who you are", async () => {
    const guessed = { owner: "dev@host:/repo", note: "no tracked session found for this directory; using dev@host:/repo." };
    const claim = await claims.claim({ cwd: "/repo", files: ["x.ts"], self: guessed, ttlMs: 60_000 });
    expect(claim.identityNote).toBe(guessed.note);
  });

  it("lists active claims at the clock's time", async () => {
    await claims.claim({ cwd: "/repo", files: ["x.ts"], self, ttlMs: 60_000 });
    expect((await claims.active()).map((c) => c.files)).toEqual([["/repo/x.ts"]]);
    const later = new ClaimsService({ store: new ClaimsStore({ home }), clock: fixedClock("2026-11-13T12:05:00.000Z") });
    expect(await later.active()).toEqual([]);
  });

  it("releases by a file path relative to the caller", async () => {
    await claims.claim({ cwd: "/repo", files: ["a.ts", "b.ts"], self, ttlMs: 60_000 });
    const result = await claims.release({ cwd: "/repo", selector: "a.ts" });
    expect(result.selector).toBe("/repo/a.ts");
    expect(result.released).toBe(1);
    expect(result.files).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  it("releases by claim id, and only the named files when given", async () => {
    const claim = await claims.claim({ cwd: "/repo", files: ["a.ts", "b.ts"], self, ttlMs: 60_000 });
    const partial = await claims.release({ cwd: "/repo", selector: claim.id, files: ["a.ts"] });
    expect(partial.selector).toBe(claim.id);
    expect(partial.files).toEqual(["/repo/a.ts"]);
    expect((await claims.active())[0]!.files).toEqual(["/repo/b.ts"]);
  });

  it("treats any selector as an id when told to", async () => {
    const result = await claims.release({ cwd: "/repo", selector: "not-a-uuid", claimId: true });
    expect(result).toEqual({ selector: "not-a-uuid", released: 0, claims: [], files: [] });
  });
});
