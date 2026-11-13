// src/app/feed.ts
//
// The project context feed as a service: post, read, expand and stats for an explicit
// project, on an injected clock. Front ends only translate their arguments; the evidence
// grammar and list splitting every front end accepts are defined here once.
import type { Engine } from "../core/engine.js";
import { PostRejectedError } from "../core/errors.js";
import {
  expandPost, feedStats, postToFeed, readFeed,
  type FeedPost, type FeedReadResult, type PostInput, type PostType,
} from "../feed/index.js";
import type { ProjectRef } from "./project.js";
import type { Clock } from "./time.js";

export type Evidence = PostInput["evidence"] extends (infer E)[] | undefined ? E : never;

/** A comma-separated list with blanks dropped; an absent value is an empty list. */
export function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Evidence refs: `file:<path>[:line]`, `commit:<sha>`, `session:<id>`. A file path may
 * itself contain colons, so only a trailing all-digit segment is read as a line.
 */
export function parseEvidenceRefs(refs: readonly string[]): Evidence[] {
  return refs.map((entry) => {
    const [kind, ...rest] = entry.split(":");
    if (kind === "file") {
      const line = rest.length > 1 && /^\d+$/.test(rest[rest.length - 1]!) ? Number(rest.pop()) : undefined;
      return { kind: "file" as const, path: rest.join(":"), line };
    }
    if (kind === "commit" || kind === "session") return { kind, ref: rest.join(":") };
    throw new PostRejectedError(`evidence "${entry}" must start with file:, commit:, or session:`);
  });
}

export type PostRequest = Omit<PostInput, "project" | "author">;

export interface ReadRequest {
  budget?: number;
  contextPaths?: string[];
  since?: string;
  types?: PostType[];
  reader?: string;
  includeDerived?: boolean;
}

export class FeedService {
  /**
   * `engine` resolves authors and derives status posts. Expand and stats never need it,
   * so a front end serving only those can leave it out and skip adapter discovery.
   */
  constructor(private readonly deps: { clock: Clock; engine?: Engine; home?: string }) {}

  post(project: ProjectRef, input: PostRequest, opts: { as?: string } = {}): Promise<FeedPost> {
    return postToFeed({
      dir: project.dir,
      engine: this.deps.engine,
      home: this.deps.home,
      as: opts.as,
      input,
      now: this.deps.clock.now(),
    });
  }

  read(project: ProjectRef, req: ReadRequest = {}): Promise<FeedReadResult> {
    return readFeed({
      dir: project.dir,
      engine: this.deps.engine,
      home: this.deps.home,
      budget: req.budget,
      contextPaths: req.contextPaths,
      since: req.since,
      types: req.types,
      reader: req.reader,
      includeDerived: req.includeDerived,
      now: this.deps.clock.now(),
    });
  }

  expand(project: ProjectRef, postId: string): Promise<FeedPost> {
    return expandPost({ dir: project.dir, postId, home: this.deps.home });
  }

  stats(project: ProjectRef): ReturnType<typeof feedStats> {
    return feedStats({ dir: project.dir, home: this.deps.home });
  }
}
