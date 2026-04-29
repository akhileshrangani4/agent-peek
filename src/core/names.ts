// src/core/names.ts
import { basename } from "node:path";
import type { SessionEntry } from "./types.js";

export type NameableSession = Pick<SessionEntry, "id" | "adapter"> & Partial<Pick<SessionEntry, "tag" | "name" | "cwd">>;

export function displayName(entry: NameableSession): string {
  if (entry.tag) return entry.tag;
  if (entry.name) return entry.name;
  const cwd = entry.cwd ? basename(entry.cwd) : "";
  if (cwd && cwd !== "." && cwd !== "/") return `${cwd}-${shortAdapter(entry.adapter)}`;
  return decodeIdTail(entry.id);
}

export function displayNames(entries: readonly NameableSession[]): string[] {
  const bases = entries.map(displayName);
  const totals = new Map<string, number>();
  for (const base of bases) totals.set(base, (totals.get(base) ?? 0) + 1);

  const reserved = new Set(bases.filter((base) => totals.get(base) === 1));
  const seen = new Map<string, number>();
  const used = new Set<string>();

  return bases.map((base) => {
    if (totals.get(base) === 1) {
      used.add(base);
      return base;
    }

    let index = (seen.get(base) ?? 0) + 1;
    let candidate = index === 1 ? base : `${base}-${index}`;
    while (used.has(candidate) || (candidate !== base && reserved.has(candidate))) {
      index++;
      candidate = `${base}-${index}`;
    }
    seen.set(base, index);
    used.add(candidate);
    return candidate;
  });
}

function shortAdapter(adapter: string): string {
  switch (adapter) {
    case "claude-code": return "claude";
    case "copilot-cli": return "copilot";
    default: return adapter;
  }
}

function decodeIdTail(id: string): string {
  const tail = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
  try { return decodeURIComponent(tail); } catch { return tail; }
}
