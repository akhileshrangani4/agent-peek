// src/adapters/common.ts
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RawMessage, ToolCall } from "../core/types.js";

export function statusFromMtime(ms: number): "active" | "idle" | "ended" {
  const ageMs = Date.now() - ms;
  return ageMs < 5 * 60 * 1000 ? "active"
       : ageMs < 24 * 3600 * 1000 ? "idle"
       : "ended";
}

export async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export async function newestMtime(paths: string[], fallback: number): Promise<number> {
  let newest = fallback;
  for (const path of paths) {
    try {
      const st = await stat(path);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    } catch { /* ignore unreadable file */ }
  }
  return newest;
}

export function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    const parts = value.map(extractText).filter((v): v is string => Boolean(v));
    return parts.length ? parts.join("\n") : undefined;
  }
  const obj = value as Record<string, unknown>;
  for (const key of ["text", "content", "message", "value", "body", "output", "summary"]) {
    const text = extractText(obj[key]);
    if (text) return text;
  }
  return undefined;
}

export function normalizeRole(value: unknown): RawMessage["role"] {
  if (value === "assistant" || value === "agent") return "assistant";
  if (value === "user" || value === "human") return "user";
  if (value === "tool" || value === "tool_result" || value === "function") return "tool";
  return "system";
}

export function toolCallFromPart(part: Record<string, unknown>): ToolCall | undefined {
  const type = part.type;
  if (type !== "tool" && type !== "tool_use" && type !== "tool_call" && type !== "function_call") return undefined;
  const state = part.state && typeof part.state === "object" ? part.state as Record<string, unknown> : {};
  const status = state.status === "completed" ? "completed"
              : state.status === "error" ? "error"
              : "pending";
  return {
    name: typeof part.tool === "string" ? part.tool
      : typeof part.name === "string" ? part.name
      : "?",
    input: state.input ?? part.input ?? part.arguments,
    output: state.output ?? state.error ?? part.output,
    status,
  };
}

