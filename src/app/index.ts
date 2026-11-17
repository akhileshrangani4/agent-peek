// src/app/index.ts
//
// The application layer: the one set of rules the CLI, the stdio MCP server and the
// future HTTP host call. Front ends parse their own arguments and render their own
// output; everything between those two edges lives behind these services.
import { ClaimsStore } from "../core/claims.js";
import type { Engine } from "../core/engine.js";
import { ClaimsService } from "./claims.js";
import { CoordinationService } from "./coordination.js";
import { createEngine, type CreateEngineOpts } from "./engine.js";
import { FeedService } from "./feed.js";
import { SessionsService } from "./sessions.js";
import { systemClock, type Clock } from "./time.js";

export interface App {
  readonly engine: Engine;
  readonly clock: Clock;
  readonly sessions: SessionsService;
  readonly coordination: CoordinationService;
  readonly feed: FeedService;
  readonly claims: ClaimsService;
}

export interface AppOptions extends CreateEngineOpts {
  clock?: Clock;
  /** State directory root for the feed and claims stores. Defaults to the user's home. */
  home?: string;
  /** Use this engine instead of composing one; tests inject a fixture engine. */
  engine?: Engine;
}

/** Services over one engine. Constructing them touches no disk; the stores open on use. */
export function appFor(engine: Engine, opts: { clock?: Clock; home?: string } = {}): App {
  const clock = opts.clock ?? systemClock;
  return {
    engine,
    clock,
    sessions: new SessionsService(engine),
    coordination: new CoordinationService(engine),
    feed: new FeedService({ clock, engine, home: opts.home }),
    claims: claimsService({ clock, home: opts.home }),
  };
}

/** Claims alone: releasing a claim needs no adapter discovery, so it builds no engine. */
export function claimsService(opts: { clock?: Clock; home?: string } = {}): ClaimsService {
  return new ClaimsService({
    store: new ClaimsStore(opts.home ? { home: opts.home } : {}),
    clock: opts.clock ?? systemClock,
  });
}

/**
 * The feed without adapter discovery: what `expand` and `stats` need. Posting or reading
 * through it would resolve no author and derive no status posts, so those use `createApp`.
 */
export function feedService(opts: { clock?: Clock; home?: string } = {}): FeedService {
  return new FeedService({ clock: opts.clock ?? systemClock, home: opts.home });
}

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const { clock, home, engine, ...engineOpts } = opts;
  return appFor(engine ?? await createEngine(engineOpts), { clock, home });
}

export { ClaimsService } from "./claims.js";
export { CoordinationService } from "./coordination.js";
export { FeedService } from "./feed.js";
export { SessionsService } from "./sessions.js";
export { UsageService } from "./usage.js";
export type { Clock } from "./time.js";
export { systemClock, fixedClock } from "./time.js";
export type { ProjectRef } from "./project.js";
export { projectAt } from "./project.js";
