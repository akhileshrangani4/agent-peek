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

/**
 * Wrap prose to a width, breaking on spaces.
 *
 * Non-table lines need the width contract as much as tables do: a legend row and a
 * trailing explanation are the two that escape a table-owned clamp, because neither is
 * a table. Kept here so headers and footers do not each re-invent wrapping.
 */
export function wrap(text: string, width: number, indent = ""): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = indent + words[0]!;
  for (const word of words.slice(1)) {
    const next = `${line} ${word}`;
    if (displayWidth(next) > width) { lines.push(line); line = indent + word; }
    else line = next;
  }
  lines.push(line);
  return lines;
}

/**
 * Wrap a comma-separated list under a label, continuing on indented lines.
 *
 * The items are the content — `usage not observable: amp, antigravity, cline, …` must
 * not be truncated, because the names are the answer the reader came for.
 */
export function wrapList(label: string, items: string[], width: number, indent = "  "): string[] {
  if (items.length === 0) return [];
  return wrap(`${label}: ${items.join(", ")}`, width, indent)
    .map((line, i) => (i === 0 ? line : `  ${line}`));
}
