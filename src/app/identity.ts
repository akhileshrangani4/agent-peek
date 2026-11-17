// src/app/identity.ts
//
// Who "you" are to peek when you make a claim or run `check`. One rule, shared by every
// front end: the tracked session that is you, else a stable user@host:dir fallback with
// a note saying why.
import { hostname, userInfo } from "node:os";
import type { Engine } from "../core/engine.js";
import { resolveAuthor } from "../feed/identity.js";

export interface SelfIdentity {
  /** The owner string claims and conflicts are matched on. */
  owner: string;
  /** Set when peek fell back from a tracked session, so the caller can say why. */
  note?: string;
  /** The tracked session id, when one was found. */
  session?: string;
}

/**
 * CLAUDE_SESSION_ID when the harness sets it, else the session whose cwd is this
 * directory. No pid of any kind: every peek call is a new process, and for an agent every
 * shell command is a new shell too, so neither pid nor parent pid ever matched again and
 * --ignore-self could not recognise a claim made a second earlier. Untracked agents fall
 * back to user, host and directory.
 */
export async function resolveSelf(engine: Engine | undefined, cwd: string): Promise<SelfIdentity> {
  const author = await resolveAuthor({ cwd, engine });
  if (!author.anonymous) return { owner: author.session, session: author.session };
  const owner = `${userInfo().username || "agent"}@${hostname()}:${cwd}`;
  if (author.ambiguousSessions?.length) {
    return {
      owner,
      note: `could not tell which of ${author.ambiguousSessions.length} live sessions in this directory is you (${author.ambiguousSessions.join(", ")}); using ${owner}. Set CLAUDE_SESSION_ID or pass --as <name> for a stable identity.`,
    };
  }
  return { owner, note: `no tracked session found for this directory; using ${owner}.` };
}
