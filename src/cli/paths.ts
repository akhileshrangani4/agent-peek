// src/cli/paths.ts
//
// Path and width helpers for terminal output. Kept in their own file with a single
// owner: `render.ts` (tables, colour roles, overflow) is owned elsewhere, and a shared
// file with two writers is how edits get silently lost.

const ANSI = /\[[0-9;]*m/g;

/**
 * Display width in characters, not bytes.
 *
 * `awk '{print length}'` and a byte count disagree with the terminal the moment a line
 * contains a middle dot or an ellipsis: a three-byte character reads as three columns
 * and a layout gets redesigned around a limit it never exceeded.
 */
export function displayWidth(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

/**
 * Shorten a path for a column, keeping the end.
 *
 * The tail is what a reader identifies a session by: in
 * `~/.superset/worktrees/94fce017-5ef7-4a1a-ad79-10405254c6b0/avi/mangrove-ziconium`
 * the UUID is noise and `avi/mangrove-ziconium` is the answer. Home collapses to `~`,
 * then the middle is elided down to the last two segments.
 */
export function shortenPath(path: string, max: number, home = process.env.HOME): string {
  const text = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  if (displayWidth(text) <= max) return text;

  const segments = text.split("/").filter(Boolean);
  const tail = segments.slice(-2).join("/");
  const head = text.startsWith("~") ? "~" : "";
  const elided = `${head}/…/${tail}`;
  if (displayWidth(elided) <= max) return elided;

  // Even the tail is too wide: keep its end, which is the distinguishing part.
  return `…${[...tail].slice(-(max - 1)).join("")}`;
}

/** Truncate to a column budget, marking that something was cut. */
export function fit(text: string, max: number): string {
  if (displayWidth(text) <= max) return text;
  return `${[...text].slice(0, Math.max(0, max - 1)).join("")}…`;
}
