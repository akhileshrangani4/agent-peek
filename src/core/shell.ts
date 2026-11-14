// src/core/shell.ts
//
// Just enough of a shell reader to know which directory each command in an agent's
// shell call ran in, and what that command did to which files. Agents chain
// `cd apps/server && sed -i … src/a.ts`; resolving `src/a.ts` against the session cwd
// instead of `apps/server` drops the real edit or, worse, pins it on a same-named file
// somewhere else (issue #7).
//
// This is a reader, not an interpreter: no expansion, no globbing, no functions. When
// the text cannot say where a command runs (`cd ~`, `cd "$DIR"`, `cd -`), the commands
// after it have no known directory and their relative paths are not resolved at all.
// A missing path is a gap; a wrong one is a false write in `check`.

import { basename, isAbsolute, join, normalize } from "node:path";

/** One simple command from a shell script, with the directory it runs in. */
export interface ShellCommand {
  /** The command's own text: no separators, no heredoc bodies. */
  text: string;
  /** Words with quotes removed. Redirect operators and their targets are left out. */
  words: string[];
  /** Bodies of the heredocs this command reads, in order. */
  heredocs: string[];
  /**
   * The directory the command runs in: the script's base directory joined with every
   * `cd` before it, or undefined once a `cd` went somewhere the text cannot tell.
   */
  dir: string | undefined;
}

export interface ShellParseOptions {
  /** The git toplevel above an absolute directory, for `cd "$(git rev-parse --show-toplevel)"`. */
  toplevel?: (dir: string) => string | undefined;
}

/** What one command did to a file. Paths are resolved against the command's directory. */
export type FileOp =
  /** `create` is known-new (`*** Add File`), `modify` is known-existing (an in-place edit), `write` is either. */
  | { op: "write"; path: string; mode: "create" | "modify" | "write" }
  | { op: "move"; from: string; to: string }
  | { op: "delete"; path: string };

/**
 * Split a script into simple commands and track the working directory across them.
 * `baseDir` is the directory the script starts in; pass "." when it is unknown and
 * relative results stay relative to it.
 */
export function parseShell(script: string, baseDir: string, opts: ShellParseOptions = {}): ShellCommand[] {
  const base = normalize(baseDir);
  // A bare apply_patch payload is not a shell script: its code lines would be read as
  // commands and an apostrophe in one would swallow every header after it.
  if (/^\s*\*\*\* Begin Patch/.test(script)) return [{ text: "", words: [], heredocs: [script], dir: base }];
  const out: ShellCommand[] = [];
  let dir: string | undefined = base;
  const subshells: (string | undefined)[] = [];
  const pushed: (string | undefined)[] = [];
  for (const segment of splitSegments(script)) {
    for (let i = 0; i < segment.opens; i++) subshells.push(dir);
    const words = shellWords(segment.text);
    out.push({ text: segment.text, words, heredocs: segment.heredocs, dir });
    // A `cd` in a pipeline or a background job runs in its own subshell.
    if (!segment.isolated) dir = nextDir(words, dir, pushed, opts);
    for (let i = 0; i < segment.closes; i++) {
      if (subshells.length) dir = subshells.pop();
    }
  }
  return out;
}

/** Resolve a path named in a command against the directory the command ran in. */
export function resolveIn(dir: string | undefined, path: string): string | undefined {
  const trimmed = path.trim();
  // `~/x` is under a home directory the transcript does not name, not a relative path.
  if (!trimmed || trimmed.startsWith("~")) return undefined;
  if (isAbsolute(trimmed)) return stripTrailingSlash(normalize(trimmed));
  if (dir === undefined) return undefined;
  return stripTrailingSlash(join(dir, trimmed));
}

/** Every file operation a script performs, in order, resolved against each command's directory. */
export function scriptFileOps(script: string, baseDir: string, opts: ShellParseOptions = {}): FileOp[] {
  return parseShell(script, baseDir, opts).flatMap(commandFileOps);
}

/** Every path-like token a script names, resolved against each command's directory. */
export function scriptPaths(script: string, baseDir: string, opts: ShellParseOptions = {}): string[] {
  return parseShell(script, baseDir, opts).flatMap(commandPaths);
}

/** The path a file operation leaves written: the target, or a move's destination. */
export function writtenPathOf(op: FileOp): string {
  return op.op === "move" ? op.to : op.path;
}

// ---------------------------------------------------------------------------
// What a command does

const OPERAND_WRITERS = /^(tee|touch|mkdir)$/;
const OPERAND_DELETERS = /^(rm|rmdir|unlink)$/;
const DEST_WRITERS = /^(cp|install|ln)$/;
const INPLACE_EDITORS = /^(sed|perl)$/;

export function commandFileOps(command: ShellCommand): FileOp[] {
  const ops: FileOp[] = [];
  const at = (path: string) => resolveIn(command.dir, path);
  for (const source of [command.text, ...command.heredocs]) ops.push(...patchOps(source, at));
  for (const target of redirectTargets(command.text)) {
    const path = at(target);
    if (path) ops.push({ op: "write", path, mode: "write" });
  }
  const head = commandHead(command.words);
  if (!head) return ops;
  const name = basename(head.name);
  const operands = operandsOf(name, head.args);
  if (OPERAND_DELETERS.test(name)) ops.push(...deletes(operands, at));
  else if (OPERAND_WRITERS.test(name)) ops.push(...writes(operands, "write", at));
  else if (name === "truncate") ops.push(...writes(operands, "modify", at));
  else if (name === "mv") ops.push(...moves(operands, at));
  else if (DEST_WRITERS.test(name) && operands.length >= 2) ops.push(...writes(operands.slice(-1), "write", at));
  else if (INPLACE_EDITORS.test(name) && head.args.some(isInPlaceFlag)) {
    // The script is an operand too; only operands shaped like repo paths are files.
    ops.push(...writes(operands.filter(looksLikeCommandPath), "modify", at));
  } else if (name === "git") ops.push(...gitOps(head.args, at));
  return ops;
}

/** Options whose next word is their value, not a file: `truncate -s 0 log.txt`, `mkdir -m 755 dir`. */
const VALUED_OPTIONS: Record<string, ReadonlySet<string>> = {
  truncate: new Set(["-s", "-r", "--size", "--reference"]),
  touch: new Set(["-d", "-t", "-r", "--date", "--reference"]),
  mkdir: new Set(["-m", "--mode"]),
};

function operandsOf(name: string, args: string[]): string[] {
  const valued = VALUED_OPTIONS[name];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    if (!word.startsWith("-")) operands.push(word);
    else if (valued?.has(word)) i++;
  }
  return operands;
}

/** `sed -i`, `sed -i.bak`, `sed -i ''`, `perl -i -pe`, `sed --in-place`. */
function isInPlaceFlag(word: string): boolean {
  return word.startsWith("-i") || word === "--in-place" || word.startsWith("--in-place=");
}

function writes(operands: string[], mode: "create" | "modify" | "write", at: (p: string) => string | undefined): FileOp[] {
  return operands.filter(isPlausibleWriteTarget).flatMap((operand) => {
    const path = at(operand);
    return path ? [{ op: "write" as const, path, mode }] : [];
  });
}

function deletes(operands: string[], at: (p: string) => string | undefined): FileOp[] {
  return operands.filter(isPlausibleWriteTarget).flatMap((operand) => {
    const path = at(operand);
    return path ? [{ op: "delete" as const, path }] : [];
  });
}

/** `mv a b` renames; `mv a b dir/` (or a trailing slash, or a file into an extensionless name) moves into a directory. */
function moves(operands: string[], at: (p: string) => string | undefined): FileOp[] {
  if (operands.length < 2) return [];
  const destination = operands[operands.length - 1]!;
  if (!isPlausibleWriteTarget(destination)) return [];
  const sources = operands.slice(0, -1).filter(isPlausibleWriteTarget);
  const ops: FileOp[] = [];
  for (const source of sources) {
    const intoDir = sources.length > 1 || destination.endsWith("/") || (!hasExtension(destination) && hasExtension(source));
    const from = at(source);
    const to = at(intoDir ? join(destination, basename(source)) : destination);
    if (from && to) ops.push({ op: "move", from, to });
  }
  return ops;
}

/** `git [-C dir] mv …` and `git [-C dir] rm …`; `git rm --cached` leaves the file on disk. */
function gitOps(args: string[], at: (p: string) => string | undefined): FileOp[] {
  let index = 0;
  let within: string | undefined = "";
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "-C") {
      const dir = args[index + 1] ?? "";
      within = within === undefined || /[$`~]/.test(dir) ? undefined : isAbsolute(dir) ? dir : join(within, dir);
      index += 2;
    } else if (arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") index += 2;
    else if (arg.startsWith("-")) index += 1;
    else break;
  }
  const subcommand = args[index];
  const rest = args.slice(index + 1);
  const atGit = (path: string) => {
    if (isAbsolute(path)) return at(path);
    if (within === undefined) return undefined;
    return at(within ? join(within, path) : path);
  };
  const operands = rest.filter((word) => !word.startsWith("-"));
  if (subcommand === "mv") return moves(operands, atGit);
  if (subcommand === "rm" && !rest.includes("--cached")) return deletes(operands, atGit);
  return [];
}

const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;

/** apply_patch envelopes name their files: Add creates, Update edits (and may move), Delete deletes. */
function patchOps(source: string, at: (p: string) => string | undefined): FileOp[] {
  const ops: FileOp[] = [];
  let updating: string | undefined;
  for (const match of source.matchAll(PATCH_HEADER)) {
    const moveTo = match[3]?.trim();
    if (moveTo) {
      const to = at(moveTo);
      if (updating && to) ops.push({ op: "move", from: updating, to });
      updating = undefined;
      continue;
    }
    const path = at(match[2]?.trim() ?? "");
    updating = undefined;
    if (!path) continue;
    if (match[1] === "Add") ops.push({ op: "write", path, mode: "create" });
    else if (match[1] === "Update") {
      ops.push({ op: "write", path, mode: "modify" });
      updating = path;
    } else ops.push({ op: "delete", path });
  }
  return ops;
}

// Output redirects: `> file`, `>> file`, `2> file`, `&> file`; not `<`, `<<`, `2>&1`,
// and not the `>` inside `=>` or `->`, which is code quoted in the command, not a redirect.
const REDIRECT = /(?:^|[^<>=-])(?:\d?>>?|&>)\s*(['"]?)([^\s'"|;&<>]+)\1/g;

function redirectTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(REDIRECT)) {
    const path = match[2];
    if (path && !path.startsWith("&") && path !== "/dev/null" && isPlausibleWriteTarget(path)) targets.push(path);
  }
  return targets;
}

/** A write target is a path, not a code fragment or an unexpanded variable. */
export function isPlausibleWriteTarget(value: string): boolean {
  if (!value || /[()[\]{}<>|;&=`\\]/.test(value)) return false;
  if (value.includes("$")) return false;
  return /^[\w.~@/-]+$/.test(value);
}

// ---------------------------------------------------------------------------
// What a command mentions

const PATH_TOKEN = /(?:^|[\s'"])(\.{0,2}\/?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9]{1,12})?)(?=$|[\s'"]|[:,;)])/g;

function commandPaths(command: ShellCommand): string[] {
  const paths: string[] = [];
  for (const source of [command.text, ...command.heredocs]) {
    for (const match of source.matchAll(PATCH_HEADER)) {
      const path = resolveIn(command.dir, (match[2] ?? match[3] ?? "").trim());
      if (path) paths.push(path);
    }
    for (const match of source.matchAll(PATH_TOKEN)) {
      // A path at the end of a sentence carries the sentence's punctuation.
      const token = match[1]?.replace(/^['"]|['"]$/g, "").replace(/[.,;:]+$/, "");
      if (!token || !looksLikeCommandPath(token) || token.includes("://")) continue;
      const path = resolveIn(command.dir, token);
      if (path) paths.push(path);
    }
  }
  return paths;
}

export function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("\n")) return false;
  return trimmed.startsWith("/")
    || trimmed.startsWith("./")
    || trimmed.startsWith("../")
    || trimmed.includes("/")
    || /\.[A-Za-z0-9]{1,8}$/.test(trimmed);
}

/** A path scraped out of command text: absolute, explicitly relative, or under a known repo root. */
export function looksLikeCommandPath(value: string): boolean {
  if (!looksLikePath(value)) return false;
  if (value.includes("node_modules/")) return false;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  const first = value.split("/")[0];
  return ["bin", "docs", "skills", "src", "test"].includes(first ?? "");
}

// ---------------------------------------------------------------------------
// Directories

/** Prefixes that run the command after them: `sudo rm x`, `FOO=1 rm x`, `then rm x`. */
const COMMAND_PREFIXES = new Set(["sudo", "{", "!", "if", "then", "else", "elif", "do", "while", "until", "time", "command", "builtin", "exec", "nohup"]);

/** The command a word list runs, past assignments and prefixes. */
export function commandHead(words: string[]): { name: string; args: string[] } | undefined {
  let index = 0;
  while (index < words.length && (COMMAND_PREFIXES.has(words[index]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!))) index++;
  const name = words[index];
  return name ? { name, args: words.slice(index + 1) } : undefined;
}

const TOPLEVEL = /^(?:\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)|`\s*git\s+rev-parse\s+--show-toplevel\s*`)$/;

function nextDir(
  words: string[],
  dir: string | undefined,
  pushed: (string | undefined)[],
  opts: ShellParseOptions,
): string | undefined {
  const head = commandHead(words);
  if (!head) return dir;
  if (head.name === "popd") return pushed.length ? pushed.pop() : undefined;
  if (head.name !== "cd" && head.name !== "pushd") return dir;
  if (head.name === "pushd") pushed.push(dir);
  const target = head.args.find((arg) => !/^-[LPe@]+$/.test(arg));
  // `cd` alone goes home and `cd -` goes back: neither is in the text.
  if (target === undefined || target === "-") return undefined;
  if (TOPLEVEL.test(target)) return dir !== undefined && isAbsolute(dir) ? opts.toplevel?.(dir) : undefined;
  if (/[$`~*?]/.test(target)) return undefined;
  if (isAbsolute(target)) return stripTrailingSlash(normalize(target));
  return dir === undefined ? undefined : stripTrailingSlash(join(dir, target));
}

// ---------------------------------------------------------------------------
// Lexing

interface Segment {
  text: string;
  heredocs: string[];
  /** Runs in its own subshell: part of a pipeline or a background job. */
  isolated: boolean;
  /** Subshells `(` opened before this command and closed `)` after it. */
  opens: number;
  closes: number;
}

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
  segment: Segment;
}

function emptySegment(): Segment {
  return { text: "", heredocs: [], isolated: false, opens: 0, closes: 0 };
}

/** Split on `&&`, `||`, `;`, `|`, `&` and newlines outside quotes, `$(…)` and heredoc bodies. */
function splitSegments(script: string): Segment[] {
  const segments: Segment[] = [];
  let current = emptySegment();
  let quote: string | undefined;
  let substitution = 0;
  let literalParens = 0;
  let pipedIn = false;
  let pending: PendingHeredoc[] = [];

  const finish = (separator: string) => {
    const text = current.text.trim();
    if (!text) {
      current.text = "";
      return;
    }
    current.text = text;
    current.isolated = pipedIn || separator === "|" || separator === "&";
    segments.push(current);
    pipedIn = separator === "|";
    current = emptySegment();
    literalParens = 0;
  };

  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    const next = script[i + 1];
    if (quote) {
      current.text += c;
      if (c === "\\" && quote !== "'" && next !== undefined) {
        current.text += next;
        i++;
      } else if (c === quote) quote = undefined;
      continue;
    }
    if (c === "\\") {
      // A backslash-newline continues the line.
      if (next !== "\n") current.text += c + (next ?? "");
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      current.text += c;
      continue;
    }
    if (substitution > 0) {
      current.text += c;
      if (c === "(") substitution++;
      else if (c === ")") substitution--;
      continue;
    }
    if (c === "$" && next === "(") {
      substitution = 1;
      current.text += "$(";
      i++;
      continue;
    }
    if (c === "#" && (current.text === "" || /\s$/.test(current.text))) {
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
      continue;
    }
    if (script.startsWith("<<<", i)) {
      current.text += "<<<";
      i += 2;
      continue;
    }
    if (c === "<" && next === "<") {
      const match = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(script.slice(i));
      if (match) {
        pending.push({ delimiter: match[3]!, stripTabs: match[1] === "-", segment: current });
        current.text += match[0];
        i += match[0].length - 1;
        continue;
      }
    }
    if (c === "\n") {
      finish("\n");
      if (pending.length) {
        i = readHeredocs(script, i + 1, pending) - 1;
        pending = [];
      }
      continue;
    }
    if (c === "&" && next === "&") {
      finish("&&");
      i++;
      continue;
    }
    if (c === "|" && next === "|") {
      finish("||");
      i++;
      continue;
    }
    if (c === "|") {
      if (next === "&") i++;
      finish("|");
      continue;
    }
    if (c === ";") {
      if (next === ";") i++;
      finish(";");
      continue;
    }
    if (c === "&") {
      // `2>&1`, `<&3` and `&>file` are redirects, not a background job.
      const previous = current.text.at(-1);
      if (previous === ">" || previous === "<" || next === ">") current.text += c;
      else finish("&");
      continue;
    }
    if (c === "(") {
      if (current.text.trim() === "") current.opens++;
      else {
        literalParens++;
        current.text += c;
      }
      continue;
    }
    if (c === ")") {
      if (literalParens > 0) {
        literalParens--;
        current.text += c;
      } else if (current.text.trim()) {
        current.closes++;
        finish(")");
      } else {
        const last = segments.at(-1);
        if (last) last.closes++;
      }
      continue;
    }
    current.text += c;
  }
  finish("");
  return segments;
}

/** Read heredoc bodies starting at `start`; returns the index just past the last terminator. */
function readHeredocs(script: string, start: number, pending: PendingHeredoc[]): number {
  let position = start;
  for (const doc of pending) {
    const lines: string[] = [];
    while (position < script.length) {
      const end = script.indexOf("\n", position);
      const line = script.slice(position, end === -1 ? script.length : end);
      position = end === -1 ? script.length : end + 1;
      if ((doc.stripTabs ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
      lines.push(line);
    }
    doc.segment.heredocs.push(lines.join("\n"));
  }
  return position;
}

const REDIRECT_WORD = /^(?:\d+|&)?(?:>>?|<<-?|<>|<|>\||>&|<&)(.*)$/s;

/** Shell words with quotes removed; `$(…)` stays one word; redirects and their targets are dropped. */
export function shellWords(text: string): string[] {
  const raw: { word: string; quoted: boolean }[] = [];
  let word = "";
  let inWord = false;
  let quoted = false;
  let quote: string | undefined;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) {
        if (quote === "`") word += c;
        quote = undefined;
      } else if (c === "\\" && quote === '"' && /["\\$`]/.test(text[i + 1] ?? "")) word += text[++i];
      else word += c;
      continue;
    }
    if (depth > 0) {
      word += c;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (/\s/.test(c)) {
      if (inWord) raw.push({ word, quoted });
      word = "";
      inWord = false;
      quoted = false;
      continue;
    }
    inWord = true;
    if (c === "\\" && i + 1 < text.length) word += text[++i];
    else if (c === "'" || c === '"') {
      quote = c;
      quoted = true;
    } else if (c === "`") {
      quote = c;
      word += c;
    } else if (c === "$" && text[i + 1] === "(") {
      depth = 1;
      word += "$(";
      i++;
    } else word += c;
  }
  if (inWord) raw.push({ word, quoted });
  const words: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const { word: value, quoted: wasQuoted } = raw[i]!;
    const redirect = wasQuoted ? null : REDIRECT_WORD.exec(value);
    if (redirect) {
      // `> out` names its target in the next word; `>out` and `2>&1` carry it.
      if (!redirect[1]) i++;
      continue;
    }
    words.push(value);
  }
  return words;
}

function hasExtension(path: string): boolean {
  return /\.[A-Za-z0-9]{1,12}$/.test(basename(path));
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") || "/" : path;
}
