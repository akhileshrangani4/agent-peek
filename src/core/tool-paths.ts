// src/core/tool-paths.ts
//
// Which files a tool call names, and what it did to them, resolved against the
// directory that call actually ran in. Coordination (`touchedFiles`, `writingFiles`,
// `check`) and the handoff's file roles read paths only through here, so the two can
// never disagree about where a relative path points.

import { basename, extname, isAbsolute, normalize, resolve } from "node:path";
import { gitToplevel } from "./repo-path.js";
import { looksLikePath, scriptFileOps, scriptPaths, type FileOp, type ShellParseOptions } from "./shell.js";
import type { ToolCall } from "./types.js";

const SHELL_OPTIONS: ShellParseOptions = { toplevel: (dir) => gitToplevel(dir) };

/**
 * The directory a tool call starts in: its own `workdir` or `cwd` argument (Codex's
 * `exec_command` sends `workdir`), else the session's cwd. A shell command can still
 * `cd` from there; `parseShell` follows those per command. Undefined when the call
 * names a directory the text cannot resolve (`~/x`, `$DIR`), so its relative paths
 * stay unresolved rather than landing on the session cwd.
 */
export function resolveCallCwd(tool: ToolCall, sessionCwd: string | undefined): string | undefined {
  const input = isRecord(tool.input) ? tool.input : undefined;
  const value = input?.workdir ?? input?.cwd;
  if (typeof value !== "string" || !value.trim()) return sessionCwd;
  const dir = value.trim();
  if (/[$`~*?]/.test(dir)) return undefined;
  if (isAbsolute(dir)) return normalize(dir);
  return sessionCwd ? normalize(resolve(sessionCwd, dir)) : normalize(dir);
}

/** Every path a tool call names: path arguments, plus paths scraped from its command text. */
export function toolCallPaths(tool: ToolCall, sessionCwd: string | undefined): string[] {
  const out: string[] = [];
  collectPathValues(tool.input, "", resolveCallCwd(tool, sessionCwd), out);
  return out;
}

/**
 * What a write tool did to which files, in order. A named editor writes every path
 * it was given; a shell command writes only its targets. Treating every path in a
 * command as written made `node bin/peek.js list > out.json` a write to bin/peek.js,
 * so any agent that ran a repo script showed up as writing it in `check`.
 */
export function toolCallFileOps(tool: ToolCall, sessionCwd: string | undefined): FileOp[] {
  const base = resolveCallCwd(tool, sessionCwd);
  const command = commandInput(tool.input);
  if (command !== undefined) return scriptFileOps(command, base ?? ".", SHELL_OPTIONS).map((op) => normalizeOp(op, base));
  const paths: string[] = [];
  collectPathValues(tool.input, "", base, paths);
  if (/^delete$/i.test(tool.name)) return paths.map((path) => ({ op: "delete", path }));
  const mode = /^(edit|multiedit|notebookedit|str_replace_editor)$/i.test(tool.name) ? "modify" : "write";
  return paths.map((path) => ({ op: "write", path, mode }));
}

export function isWriteTool(tool: ToolCall): boolean {
  if (/^(write|edit|multiedit|apply_patch|notebookedit|delete|move|rename|str_replace_editor)$/i.test(tool.name)) return true;
  const command = commandInput(tool.input);
  return command ? looksLikeWriteCommand(command) : false;
}

/** The shell text a tool call runs, if it runs one. */
export function commandInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const value = input.cmd ?? input.command ?? input.script ?? input.patch;
  return typeof value === "string" ? value : undefined;
}

export function normalizePath(value: string, cwd: string | undefined): string {
  const trimmed = value.trim();
  if (isAbsolute(trimmed)) return normalize(trimmed);
  if (cwd) return normalize(resolve(cwd, trimmed));
  return normalize(trimmed);
}

/** Inside the session's checkout, outside dependencies and git internals. */
export function isWithinRoot(path: string, cwd: string | undefined): boolean {
  if (path.includes("/node_modules/") || path.includes("/.git/")) return false;
  if (!cwd) return true;
  const root = normalize(resolve(cwd));
  return path === root || path.startsWith(`${root}/`);
}

export function isRelevantTouchedPath(path: string, cwd: string | undefined): boolean {
  return looksLikeFilePath(path) && isWithinRoot(path, cwd);
}

export function looksLikeFilePath(path: string): boolean {
  const name = basename(path);
  if (!name || name === "." || name === "..") return false;
  if (extname(name)) return true;
  return /^(Dockerfile|Makefile|Rakefile|Gemfile|Procfile|LICENSE|NOTICE|CHANGELOG|README|AGENTS|CLAUDE)$/i.test(name);
}

function collectPathValues(value: unknown, key: string, base: string | undefined, out: string[]): void {
  if (typeof value === "string") {
    // `~/x` names a home directory the transcript does not; joining it to the cwd would invent a path.
    if (isPathKey(key) && looksLikePath(value) && !value.trim().startsWith("~")) out.push(normalizePath(value, base));
    if (isCommandKey(key)) {
      for (const path of scriptPaths(value, base ?? ".", SHELL_OPTIONS)) out.push(normalizePath(path, base));
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathValues(item, key, base, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [childKey, childValue] of Object.entries(value)) collectPathValues(childValue, childKey, base, out);
}

function normalizeOp(op: FileOp, base: string | undefined): FileOp {
  if (op.op === "move") return { op: "move", from: normalizePath(op.from, base), to: normalizePath(op.to, base) };
  return { ...op, path: normalizePath(op.path, base) };
}

function isPathKey(key: string): boolean {
  // file_path and notebook_path are what Claude Code's Read/Edit/Write/NotebookEdit send.
  return /^(path|paths|file|files|filepath|file_path|notebook_path|filename|filenamePattern)$/i.test(key);
}

function isCommandKey(key: string): boolean {
  return /^(cmd|command|script|patch)$/i.test(key);
}

function looksLikeWriteCommand(command: string): boolean {
  return /\b(apply_patch|tee|touch|mkdir|rm|mv|cp|install|add|commit)\b/.test(command)
    || /\b(?:sed|perl)\s+-i\b/.test(command)
    || /(^|[^<])>>?\s*[A-Za-z0-9_./-]+/.test(command);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
