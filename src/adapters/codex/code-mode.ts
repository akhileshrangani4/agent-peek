// src/adapters/codex/code-mode.ts
//
// Codex "code mode" records tool use as a `custom_tool_call` named `exec` whose input
// is a JavaScript script, for example
//   text(await tools.exec_command({cmd:"sed -i … src/a.ts", workdir:"/repo/apps/server"}));
//   text(await tools.apply_patch("*** Begin Patch\n*** Update File: src/b.ts\n…"));
// so shell commands and patches never appear as `function_call` records. In the 40
// newest rollouts checked on 2026-11-13 (codex-cli 0.153–0.166), every one of 1,385
// `custom_tool_call` records was `exec`, and no `function_call` was `exec_command` or
// `apply_patch`. Without this reader, a current Codex session shows no edits at all.
//
// This reads the calls out of the script; it does not run it. A call is decoded only
// when its first argument is a literal (a string, number, boolean, null, array or
// object of those). Anything computed (`{cmd}`, `` `cat ${f}` ``, a variable) leaves the
// call's input undefined: a missing path is a gap, a guessed one is a false write.

/** One tool call written inside a code-mode `exec` script, in source order. */
export interface CodeModeCall {
  name: string;
  /** The decoded first argument, or undefined when it is not a literal. */
  input?: unknown;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/** Every `tools.<name>(…)` call in a code-mode script, outside strings and comments. */
export function codeModeCalls(code: string): CodeModeCall[] {
  const calls: CodeModeCall[] = [];
  // Each frame is a template literal waiting for its `${…}` to close, with the brace depth to match.
  const templates: number[] = [];
  let braces = 0;
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    const next = code[i + 1];
    if (c === "/" && next === "/") {
      i = skipTo(code, i, "\n");
      continue;
    }
    if (c === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end === -1 ? code.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = readQuoted(code, i).end;
      continue;
    }
    if (c === "`") {
      const end = skipTemplate(code, i + 1);
      if (end.interpolation) {
        templates.push(braces);
        braces += 1;
      }
      i = end.index;
      continue;
    }
    if (c === "{") braces += 1;
    if (c === "}") {
      braces -= 1;
      // The `}` that closes a `${` returns to the rest of the template literal.
      if (templates.length && braces === templates[templates.length - 1]) {
        templates.pop();
        const end = skipTemplate(code, i + 1);
        if (end.interpolation) {
          templates.push(braces);
          braces += 1;
        }
        i = end.index;
        continue;
      }
    }
    if (c === "t" && code.startsWith("tools.", i) && (i === 0 || !IDENT_PART.test(code[i - 1]!))) {
      const call = readCall(code, i + "tools.".length);
      if (call) calls.push(call.call);
      i = call ? call.argsAt : i + 1;
      continue;
    }
    i += 1;
  }
  return calls;
}

/** `name(` after `tools.`; the argument is decoded if it is a literal. */
function readCall(code: string, at: number): { call: CodeModeCall; argsAt: number } | undefined {
  if (!IDENT_START.test(code[at] ?? "")) return undefined;
  let end = at + 1;
  while (end < code.length && IDENT_PART.test(code[end]!)) end++;
  const name = code.slice(at, end);
  const open = skipSpace(code, end);
  if (code[open] !== "(") return undefined;
  const argsAt = open + 1;
  const value = readLiteral(code, skipSpace(code, argsAt));
  // A literal counts only if it is the whole first argument.
  const after = value ? skipSpace(code, value.end) : -1;
  const input = value && (code[after] === ")" || code[after] === ",") ? value.value : undefined;
  return { call: input === undefined ? { name } : { name, input }, argsAt };
}

interface Read {
  value: unknown;
  end: number;
}

function readLiteral(code: string, at: number): Read | undefined {
  const c = code[at];
  if (c === '"' || c === "'") {
    const quoted = readQuoted(code, at);
    return quoted.closed ? { value: quoted.value, end: quoted.end } : undefined;
  }
  if (c === "`") return readPlainTemplate(code, at);
  if (c === "{") return readObject(code, at);
  if (c === "[") return readArray(code, at);
  const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(code.slice(at, at + 40));
  if (number) return { value: Number(number[0]), end: at + number[0].length };
  for (const [word, value] of [["true", true], ["false", false], ["null", null]] as const) {
    if (code.startsWith(word, at) && !IDENT_PART.test(code[at + word.length] ?? "")) return { value, end: at + word.length };
  }
  return undefined;
}

function readObject(code: string, at: number): Read | undefined {
  const out: Record<string, unknown> = {};
  let i = skipSpace(code, at + 1);
  while (code[i] !== "}") {
    const key = readKey(code, i);
    if (!key) return undefined;
    i = skipSpace(code, key.end);
    if (code[i] !== ":") return undefined;
    const value = readLiteral(code, skipSpace(code, i + 1));
    if (!value) return undefined;
    out[key.value] = value.value;
    i = skipSpace(code, value.end);
    if (code[i] === ",") i = skipSpace(code, i + 1);
    else if (code[i] !== "}") return undefined;
  }
  return { value: out, end: i + 1 };
}

function readArray(code: string, at: number): Read | undefined {
  const out: unknown[] = [];
  let i = skipSpace(code, at + 1);
  while (code[i] !== "]") {
    const value = readLiteral(code, i);
    if (!value) return undefined;
    out.push(value.value);
    i = skipSpace(code, value.end);
    if (code[i] === ",") i = skipSpace(code, i + 1);
    else if (code[i] !== "]") return undefined;
  }
  return { value: out, end: i + 1 };
}

function readKey(code: string, at: number): { value: string; end: number } | undefined {
  const c = code[at];
  if (c === '"' || c === "'") {
    const quoted = readQuoted(code, at);
    return quoted.closed ? { value: quoted.value, end: quoted.end } : undefined;
  }
  if (!c || !(IDENT_START.test(c) || /\d/.test(c))) return undefined;
  let end = at + 1;
  while (end < code.length && IDENT_PART.test(code[end]!)) end++;
  return { value: code.slice(at, end), end };
}

/** A '…' or "…" string starting at `at`, with escapes decoded. */
function readQuoted(code: string, at: number): { value: string; end: number; closed: boolean } {
  const quote = code[at]!;
  let value = "";
  let i = at + 1;
  while (i < code.length) {
    const c = code[i]!;
    if (c === quote) return { value, end: i + 1, closed: true };
    if (c === "\n") break;
    if (c === "\\") {
      const escape = readEscape(code, i);
      value += escape.value;
      i = escape.end;
      continue;
    }
    value += c;
    i++;
  }
  return { value, end: i, closed: false };
}

/** A template literal with no `${…}`: its cooked text. */
function readPlainTemplate(code: string, at: number): Read | undefined {
  let value = "";
  let i = at + 1;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "`") return { value, end: i + 1 };
    if (c === "$" && code[i + 1] === "{") return undefined;
    if (c === "\\") {
      const escape = readEscape(code, i);
      value += escape.value;
      i = escape.end;
      continue;
    }
    value += c;
    i++;
  }
  return undefined;
}

/** Past the end of a template literal's text, or to the `${` that interrupts it. */
function skipTemplate(code: string, from: number): { index: number; interpolation: boolean } {
  let i = from;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return { index: i + 1, interpolation: false };
    if (c === "$" && code[i + 1] === "{") return { index: i + 2, interpolation: true };
    i++;
  }
  return { index: code.length, interpolation: false };
}

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };

function readEscape(code: string, at: number): { value: string; end: number } {
  const c = code[at + 1];
  if (c === undefined) return { value: "", end: at + 1 };
  if (c === "\n") return { value: "", end: at + 2 };
  if (c === "\r") return { value: "", end: code[at + 2] === "\n" ? at + 3 : at + 2 };
  if (c in SIMPLE_ESCAPES && !(c === "0" && /\d/.test(code[at + 2] ?? ""))) return { value: SIMPLE_ESCAPES[c]!, end: at + 2 };
  if (c === "x") {
    const hex = /^[0-9a-fA-F]{2}/.exec(code.slice(at + 2, at + 4));
    if (hex) return { value: String.fromCharCode(parseInt(hex[0], 16)), end: at + 4 };
  }
  if (c === "u") {
    const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(code.slice(at + 2, at + 10));
    if (braced) {
      const point = parseInt(braced[1]!, 16);
      if (point <= 0x10ffff) return { value: String.fromCodePoint(point), end: at + 2 + braced[0].length };
    }
    const hex = /^[0-9a-fA-F]{4}/.exec(code.slice(at + 2, at + 6));
    if (hex) return { value: String.fromCharCode(parseInt(hex[0], 16)), end: at + 6 };
  }
  return { value: c, end: at + 2 };
}

function skipSpace(code: string, at: number): number {
  let i = at;
  while (i < code.length && /\s/.test(code[i]!)) i++;
  return i;
}

function skipTo(code: string, at: number, char: string): number {
  const end = code.indexOf(char, at);
  return end === -1 ? code.length : end;
}
