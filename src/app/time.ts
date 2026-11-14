// src/app/time.ts
//
// Time for the service layer: an injectable clock, and the duration and instant rules
// every front end shares (`--ttl 2m`, `--since 7d`, `ttl_ms`). Pure; no front end
// should re-derive what "7d" means.

/** The services' source of "now". Tests pass a fixed clock; everything else the system one. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string): Clock {
  const instant = new Date(at);
  return { now: () => new Date(instant) };
}

/** Why a duration was refused: unparseable text, or a value that is not a positive safe integer. */
export type DurationProblem = "format" | "non-positive";

export type DurationResult =
  | { ok: true; ms: number }
  | { ok: false; problem: DurationProblem };

const DURATION = /^(\d+)(ms|s|m|h|d)?$/i;
const UNIT_MS: Readonly<Record<string, number>> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

/** `30s`, `2m`, `1h`, `7d`, `500ms`, or a bare number of seconds. */
export function parseDuration(text: string): DurationResult {
  const match = DURATION.exec(text.trim());
  if (!match) return { ok: false, problem: "format" };
  const unit = (match[2] ?? "s").toLowerCase();
  const ms = Number(match[1]) * UNIT_MS[unit]!;
  if (!Number.isSafeInteger(ms) || ms <= 0) return { ok: false, problem: "non-positive" };
  return { ok: true, ms };
}

export type InstantResult =
  | { ok: true; iso: string }
  | { ok: false; problem: DurationProblem | "invalid-date" };

/**
 * A point in time given either as a duration back from `now` (`7d`, `24h`) or as a date
 * (`2026-08-01`). Retention windows make both natural, so both are accepted.
 */
export function resolveInstant(text: string, now: Date): InstantResult {
  const trimmed = text.trim();
  if (/^\d+(ms|s|m|h|d)?$/i.test(trimmed)) {
    const duration = parseDuration(trimmed);
    if (!duration.ok) return duration;
    return { ok: true, iso: new Date(now.getTime() - duration.ms).toISOString() };
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return { ok: false, problem: "invalid-date" };
  return { ok: true, iso: new Date(parsed).toISOString() };
}
