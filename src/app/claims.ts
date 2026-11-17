// src/app/claims.ts
//
// File claims: declared intent to write, which `check` and `coord` report to other
// agents. The service owns the rules around the store: who the claimer is, how paths
// are normalised, and the time a claim is stamped with.
import { resolve } from "node:path";
import type { ClaimsStore } from "../core/claims.js";
import type { FileClaim } from "../core/types.js";
import type { SelfIdentity } from "./identity.js";
import { releaseSelector, resolveTargets } from "./paths.js";
import type { Clock } from "./time.js";

export interface ClaimRequest {
  /** Directory relative paths resolve from. */
  cwd: string;
  files: readonly string[];
  /** Who is claiming, as peek resolved it. */
  self: SelfIdentity;
  /** Display owner other agents see; defaults to `self.owner`. */
  as?: string;
  ttlMs: number;
}

export interface ReleaseRequest {
  cwd: string;
  /** A claim id or a file path. */
  selector: string;
  /** Treat `selector` as a claim id even when it does not look like one. */
  claimId?: boolean;
  /** With a claim id, release only these files from it. */
  files?: readonly string[];
}

export interface ReleaseResult {
  /** The resolved selector that was matched: a claim id or an absolute path. */
  selector: string;
  released: number;
  claims: FileClaim[];
  files: string[];
}

export class ClaimsService {
  constructor(private readonly deps: { store: ClaimsStore; clock: Clock }) {}

  /** The identity note rides on the claim only when peek had to fall back to guess who you are. */
  async claim(req: ClaimRequest): Promise<FileClaim & { identityNote?: string }> {
    const claim = await this.deps.store.claim({
      files: resolveTargets(req.files, req.cwd),
      cwd: req.cwd,
      owner: req.as ?? req.self.owner,
      creator: req.self.owner,
      ttlMs: req.ttlMs,
      now: this.deps.clock.now(),
    });
    return req.self.note ? { ...claim, identityNote: req.self.note } : claim;
  }

  async release(req: ReleaseRequest): Promise<ReleaseResult> {
    const selector = releaseSelector(req.selector, req.cwd, { claimId: req.claimId });
    const files = req.files?.map((file) => resolve(req.cwd, file));
    const claims = await this.deps.store.release(selector, { files, now: this.deps.clock.now() });
    return {
      selector,
      released: claims.length,
      claims,
      files: [...new Set(claims.flatMap((claim) => claim.files))].sort(),
    };
  }

  active(): Promise<FileClaim[]> {
    return this.deps.store.list(this.deps.clock.now());
  }
}
