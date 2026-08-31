// src/cli/render.ts
//
// The shared presentation layer for peek's static reports. Ticket 15.
//
// Rendered with ink, which is already a dependency (the ticket-07 picker uses it) and
// which was verified — not assumed — to pipe cleanly: with a non-TTY stdout it emits
// plain line-based text with no escape codes and no cursor control, and it strips
// colour itself, so the NO_COLOR and non-TTY fallbacks come free rather than being
// reimplemented here.
//
// ── Two rules that are not style preferences ─────────────────────────────────
//
// 1. ONE alignment mechanism per row, and it is pre-padding inside a single <Text>.
//    Box is for vertical stacking only, never horizontal cells.
//
//    ink's flexbox defaults to `flexShrink: 1`, so a Box cell shrinks to make room for
//    a long neighbour and a row's layout ends up depending on the content of its own
//    longest cell. Observed: one row out of four silently lost two characters of
//    indent, its columns visually reordered, and its last cell wrapped — with correct
//    `padEnd` in the source. `flexShrink: 0` on every cell also works, but a default
//    that has to be remembered at each call site is a bug with a delay.
//
// 2. FOREGROUND COLOUR ONLY. ink pads inside the coloured span, so a cell renders as
//    `ESC[33munknown    ESC[39m` — trailing spaces within the colour. Invisible with a
//    foreground colour; with a background colour they would paint visible blocks.
//
// Both are load-bearing for verification too: several checks in this effort pipe these
// commands into grep. Escape codes wrap whole cells rather than landing mid-token, and
// colour-forced output with escapes stripped is byte-identical to the plain render.

import React from "react";
import { Box, Text, render } from "ink";
import { displayWidth, fit } from "./paths.js";

const h = React.createElement;

/**
 * Semantic roles. Call sites name what a value *asserts*, never a colour, so a palette
 * change is one edit here.
 *
 * `unknown` is deliberately not `warn`: ticket 06 spent real effort keeping "peek
 * cannot see this" distinct from "something is wrong", and collapsing them would undo
 * that in the one place a user reads it.
 */
export type Role = "ok" | "unknown" | "muted" | "live" | "plain";

const COLOR: Record<Role, string | undefined> = {
  ok: "green",
  unknown: "yellow",
  live: "cyan",
  muted: undefined,
  plain: undefined,
};

const DIM: Record<Role, boolean> = {
  ok: false, unknown: false, live: false, muted: true, plain: false,
};

/**
 * Colour is the primary encoding; when it is unavailable the WORD carries the meaning.
 * There is no glyph branch on purpose — a symbol that needs a legend has failed, and
 * markers that were meant as a fallback leaked into the coloured path as noise.
 *
 * So this returns a styled word or a plain word, never a symbol, and the word is
 * present in both modes: `peek skills | grep unknown` must not depend on whether the
 * output happened to be a terminal.
 */
export function state(value: string, role: Role): React.JSX.Element {
  return h(Text, { color: COLOR[role], dimColor: DIM[role] }, value);
}

/** Terminal width. 80 is the floor to degrade to, never the target. */
export function terminalWidth(explicit?: number, max = 120): number {
  const detected = explicit || process.stdout.columns || Number(process.env.COLUMNS) || 80;
  return Math.min(Math.max(detected, 40), max);
}

/** Thousands separators, one implementation, so two surfaces cannot disagree. */
export function num(value: number): string {
  return value.toLocaleString("en-US");
}

/** The "and N more" line. One wording. */
export function overflow(shown: number, total: number, hint?: string): string {
  const more = total - shown;
  return hint ? `${num(more)} more · ${hint}` : `${num(more)} more`;
}

export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - displayWidth(text))) + text;
}

/**
 * `── title ─────────────── trailing ──`, sized to the width.
 *
 * Structure without shouting: it replaces ALLCAPS headers, and both surfaces group by a
 * categorical — usage segments here, presence states in `peek agents`.
 */
export function Rule(
  props: { title: string; trailing?: string; role?: Role; width: number; marginTop?: number },
): React.JSX.Element {
  const { title, trailing, role = "plain", width, marginTop = 2 } = props;
  const left = `── ${title} `;
  const right = trailing ? ` ${trailing} ──` : "──";
  const fill = Math.max(3, width - displayWidth(left) - displayWidth(right));
  return h(Box, { marginTop },
    h(Text, { color: COLOR[role], dimColor: DIM[role], wrap: "truncate" }, left),
    h(Text, { dimColor: true }, "─".repeat(fill)),
    h(Text, { dimColor: true }, right));
}

export interface Cell {
  text: string;
  role?: Role;
  /** Column width. Omit for a trailing cell that may use whatever is left. */
  width?: number;
  align?: "left" | "right";
}

/**
 * One row, as a single <Text> with nested styling. See rule 1 above: this is the whole
 * reason the module exists rather than each surface assembling Boxes.
 *
 * The row truncates rather than wraps: a wrapped row breaks the column grid for every
 * row beneath it. Truncation happens against the width given to `renderStatic`, which
 * is also the width ink itself lays out against — there is deliberately no per-row
 * width parameter, because two sources of truth for one budget is how they diverge.
 */
export function Row(
  props: { cells: Cell[]; indent?: string; gutter?: number },
): React.JSX.Element {
  // The gutter belongs to the row, not to each caller's cell text. Leaving it to call
  // sites is how columns end up touching in one surface and not another.
  const { cells, indent = "     ", gutter = 4 } = props;
  const parts: React.ReactNode[] = [indent];
  cells.forEach((cell, i) => {
    if (i > 0) parts.push(" ".repeat(gutter));
    const sized = cell.width === undefined
      ? cell.text
      : cell.align === "right"
        ? padStart(fit(cell.text, cell.width), cell.width)
        : padEnd(fit(cell.text, cell.width), cell.width);
    parts.push(h(Text, {
      key: i,
      color: COLOR[cell.role ?? "plain"],
      dimColor: DIM[cell.role ?? "plain"],
    }, sized));
  });
  return h(Text, { wrap: "truncate" }, ...parts.map((p, i) =>
    typeof p === "string" ? h(Text, { key: `s${i}` }, p) : p));
}

/**
 * Render a static report and wait for it to finish.
 *
 * `forceColor` sets FORCE_COLOR so a `--color` flag can produce colour through a pipe,
 * which is the only way to preview styling in a pager.
 */
export async function renderStatic(
  element: React.JSX.Element,
  opts: { forceColor?: boolean; width?: number } = {},
): Promise<void> {
  if (opts.forceColor) process.env.FORCE_COLOR = "1";
  const width = terminalWidth(opts.width);
  // ink must be told the same width the layout used, or it re-wraps rows against a
  // budget the caller never agreed to.
  const stdout = Object.assign(Object.create(process.stdout), { columns: width });
  const app = render(element, { exitOnCtrlC: false, stdout: stdout as NodeJS.WriteStream });
  await app.waitUntilExit();
}

/** True when colour will actually be emitted. One place, so surfaces cannot disagree. */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}
