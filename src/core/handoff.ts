import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { HandoffSnapshot, HandoffTarget, RawMessage } from "./types.js";
import { oneLine, toStructured, toolNames, uniqueStrings } from "./snapshot.js";
import { inferTouchedFiles } from "./coordination.js";

// A handoff is what a fresh session needs to continue this one without
// re-exploring. Three ways to produce the document, in order of preference:
//
//   harness  a local agent CLI (claude, codex, ...) runs headless on the
//            user's existing login and writes it. No API key involved.
//   host     the caller is itself an agent (MCP). We hand back the prompt
//            and transcript as `material`; the host model writes it.
//   local    the regex heuristics below, with a header saying so.

export type HandoffProduce = "harness" | "material" | "local";

export interface HandoffRunner {
  name: string;
  command: string[];
  run: (prompt: string) => Promise<string>;
}

export interface BuildHandoffOpts {
  cwd?: string;
  target?: HandoffTarget;
  produce?: HandoffProduce;
  runner?: HandoffRunner;
  budgetChars?: number;
  onStatus?: (line: string) => void;
}

const TARGET_ALIASES: Record<string, HandoffTarget> = {
  generic: "generic",
  "claude-code": "claude-code", claude: "claude-code", claudecode: "claude-code",
  codex: "codex",
  gemini: "gemini",
  copilot: "copilot", "copilot-cli": "copilot",
  opencode: "opencode",
  chatgpt: "chatgpt", gpt: "chatgpt", openai: "chatgpt",
  "claude-chat": "claude-chat", "claude.ai": "claude-chat", "claude-web": "claude-chat",
};

const CHAT_TARGETS: ReadonlySet<HandoffTarget> = new Set(["chatgpt", "claude-chat"]);

export function parseHandoffTarget(value: unknown): HandoffTarget | undefined {
  if (value === undefined || value === null || value === "") return "generic";
  if (typeof value !== "string") return undefined;
  return TARGET_ALIASES[value.trim().toLowerCase()];
}

export const HANDOFF_TARGETS: readonly HandoffTarget[] = uniqueStrings(Object.values(TARGET_ALIASES)) as HandoffTarget[];

/** Heuristic handoff: regex over the transcript, no model. Kept as the fallback. */
export function toHandoff(sessionId: string, messages: RawMessage[], cwd?: string, target: HandoffTarget = "generic"): HandoffSnapshot {
  const structured = toStructured(sessionId, messages, cwd);
  const assistantText = messages
    .filter((message) => message.role === "assistant" && message.text)
    .map((message) => message.text!);
  const allText = messages
    .filter((message) => message.text && message.role !== "system")
    .map((message) => message.text!);

  const snapshot: HandoffSnapshot = {
    mode: "handoff",
    sessionId,
    messageCount: messages.length,
    activity: structured.activity,
    currentTask: structured.currentTask,
    lastAssistantMessage: structured.lastAssistantMessage,
    decisions: extractLines(assistantText, /\b(decided|decision|chose|using|implemented|added|changed|fixed|removed)\b/i, 5),
    openQuestions: extractQuestions(allText, 5),
    nextActions: extractLines(assistantText, /\b(next|todo|remaining|follow[- ]?up|need to|will)\b/i, 5),
    touchedFiles: inferTouchedFiles(messages, cwd),
    pendingTools: toolNames(structured.pendingToolCalls),
    recentTools: toolNames(structured.lastToolCalls),
    target,
    document: "",
    provider: "local",
  };
  snapshot.document = renderLocalHandoff(snapshot, localHandoffContext(messages, cwd));
  return snapshot;
}

export async function buildHandoff(sessionId: string, messages: RawMessage[], opts: BuildHandoffOpts = {}): Promise<HandoffSnapshot> {
  const target = opts.target ?? "generic";
  const base = toHandoff(sessionId, messages, opts.cwd, target);
  const produce = opts.produce ?? (opts.runner ? "harness" : "local");

  if (produce === "local") {
    // Asked for (--local) is not the same as fallen back to (no CLI found): only the
    // second should tell the reader to install something.
    if (opts.produce !== "local") return base;
    return { ...base, document: base.document.replace(/^> local fallback[^\n]*/, "> regex handoff (--local): fields below are pattern-extracted, not model-written.") };
  }

  const transcript = compressTranscript(messages, { budgetChars: opts.budgetChars });
  const prompt = renderHandoffPrompt(transcript, {
    target,
    cwd: opts.cwd,
    hints: { touchedFiles: base.touchedFiles, decisions: base.decisions, nextActions: base.nextActions, openQuestions: base.openQuestions },
  });

  if (produce === "material") {
    // The caller is the model. `document` is only the regex stub, and its header
    // must not send a host looking for a CLI it was never meant to install.
    return {
      ...base,
      provider: "host",
      material: prompt,
      document: base.document.replace(/^> local fallback[^\n]*/, "> you are the harness: write the handoff from `material`. The fields below are regex hints, not the deliverable."),
    };
  }

  if (!opts.runner) return base;
  opts.onStatus?.(`writing handoff with ${opts.runner.name} (${messages.length} messages, ~${Math.round(prompt.length / 4)} tokens in)...`);
  try {
    const document = (await opts.runner.run(prompt)).trim();
    if (!document) throw new Error(`${opts.runner.name} returned no output`);
    return { ...base, provider: "harness", runner: opts.runner.name, document };
  } catch (error) {
    const reason = (error as Error).message;
    return {
      ...base,
      runner: opts.runner.name,
      document: base.document.replace(/^> local fallback[^\n]*/, `> local fallback: ${opts.runner.name} failed (${oneLine(reason, 160)})`),
    };
  }
}

// ---------------------------------------------------------------------------
// Transcript compression

export interface CompressOpts {
  budgetChars?: number;
  resultChars?: number;
}

const DEFAULT_BUDGET_CHARS = 150_000;
const DEFAULT_RESULT_CHARS = 300;
const HEAD_SHARE = 0.2;

/**
 * Whole transcript, not a tail: user and assistant text in full, tool calls
 * collapsed to a name plus the paths and arguments that identify them, tool
 * results cut to a few hundred chars with error lines kept. Over budget, keep
 * the opening (the ask) and the tail (the state) and mark the gap.
 */
export function compressTranscript(messages: RawMessage[], opts: CompressOpts = {}): string {
  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const resultChars = opts.resultChars ?? DEFAULT_RESULT_CHARS;
  const lines = messages.map((m) => renderMessage(m, resultChars)).filter((l): l is string => Boolean(l));
  const total = lines.reduce((n, l) => n + l.length + 1, 0);
  if (total <= budget) return lines.join("\n");

  const headBudget = Math.floor(budget * HEAD_SHARE);
  const tailBudget = budget - headBudget - 60;
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > headBudget) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const line = lines[i]!;
    if (used + line.length + 1 > tailBudget) break;
    tail.unshift(line);
    used += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  return [...head, `[... ${omitted} messages omitted ...]`, ...tail].join("\n");
}

/** One transcript message as compact text: role and text, tool calls collapsed to their
 * identifying arguments, results truncated. Shared by the handoff prompt and `at --tools`. */
export function renderTranscriptLine(m: RawMessage, resultChars = DEFAULT_RESULT_CHARS): string | undefined {
  return renderMessage(m, resultChars);
}

function renderMessage(m: RawMessage, resultChars: number): string | undefined {
  if (m.role === "system") return undefined;
  const parts: string[] = [];
  if (m.text?.trim()) parts.push(`[${m.role}] ${m.text.trim()}`);
  for (const tc of m.toolCalls ?? []) {
    if (tc.name === "(result)") {
      const out = stringify(tc.output);
      if (out) parts.push(`[result] ${truncateResult(out, resultChars)}`);
      continue;
    }
    const args = summarizeInput(tc.input);
    parts.push(`[${m.role}] tool=${tc.name}${args ? ` ${args}` : ""}${tc.status && tc.status !== "completed" ? ` status=${tc.status}` : ""}`);
    if (tc.output !== undefined) {
      const out = stringify(tc.output);
      if (out) parts.push(`[result] ${truncateResult(out, resultChars)}`);
    }
  }
  return parts.length ? parts.join("\n") : undefined;
}

/** Keep what identifies the call: paths, commands, patterns. Drop file bodies. */
function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return oneLine(input, 200);
  if (typeof input !== "object") return String(input);
  const rec = input as Record<string, unknown>;
  const keep = ["file_path", "path", "filePath", "notebook_path", "command", "cmd", "pattern", "query", "url", "description", "old_string"];
  const bits: string[] = [];
  for (const key of keep) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) bits.push(`${key}=${oneLine(v, key === "old_string" ? 80 : 200)}`);
    else if (Array.isArray(v)) bits.push(`${key}=${oneLine(v.map(String).join(" "), 200)}`);
  }
  if (!bits.length) {
    const keys = Object.keys(rec);
    if (keys.length) bits.push(`keys=${keys.slice(0, 6).join(",")}`);
  }
  return bits.join(" ");
}

function truncateResult(out: string, max: number): string {
  const flat = out.replace(/\r/g, "");
  if (flat.length <= max) return flat.replace(/\n/g, "\\n");
  // Error lines are what the next session most needs to know about.
  const errors = flat.split("\n").filter((l) => /\b(error|failed|exception|not found|denied|ENOENT|panic)\b/i.test(l)).slice(0, 3);
  const headPart = flat.slice(0, max).replace(/\n/g, "\\n");
  const errPart = errors.length ? ` [errors: ${oneLine(errors.join(" | "), 240)}]` : "";
  return `${headPart}... (+${flat.length - max} chars)${errPart}`;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

// ---------------------------------------------------------------------------
// Prompt

export interface HandoffPromptOpts {
  target: HandoffTarget;
  cwd?: string;
  hints?: { touchedFiles?: string[]; decisions?: string[]; nextActions?: string[]; openQuestions?: string[] };
}

const SECTIONS = [
  ["## Goal", "The original ask in one paragraph, and how it evolved."],
  ["## Current state", "What is done, what is verified (tests run, commands that passed), what is in progress."],
  ["## Decisions and why", "Including alternatives that were rejected."],
  ["## Files", "Every touched file with one line: what changed and why."],
  ["## Open questions / blockers", "Anything unresolved or waiting on the user."],
  ["## Next actions", "Ordered, concrete, starting with the very next step."],
  ["## Gotchas", "What bit the previous session: failed commands, wrong assumptions, flaky steps."],
  ["## Environment", "cwd, git branch, env vars, commands to run things, anything the transcript shows."],
] as const;

export function renderHandoffPrompt(transcript: string, opts: HandoffPromptOpts): string {
  const chat = CHAT_TARGETS.has(opts.target);
  const lines: string[] = [
    "You are writing a handoff document so a NEW agent session can continue the work below without re-exploring.",
    "The transcript is another agent's session. Do not invent details: if something is not in the transcript, say it is unknown.",
    "Output markdown only, no preamble, starting with the line `# Handoff` and then exactly these sections in this order:",
    "",
    ...SECTIONS.map(([h, d]) => `${h}\n${d}`),
    "",
    chat
      ? [
          `The reader is a chat assistant (${opts.target}) with NO filesystem or shell: it cannot read or open files, run commands, or see the repository.`,
          "So the document must be self-contained. Inline the code excerpts and error output the reader needs, taken from the transcript's tool results, in fenced code blocks with the path as a caption.",
          "Explain the repository layout in prose. Give the reader enough to advise or write code without ever asking to see a file.",
        ].join("\n")
      : [
          `The reader is a coding agent (${opts.target}) with filesystem and shell access${opts.cwd ? ` in \`${opts.cwd}\`` : ""}.`,
          "Reference files by path instead of pasting them. Where a claim can be checked, say how (a command to run, a file to open).",
          `Open the document with one line telling the reader it is continuing work started by another session${opts.cwd ? ` in \`${opts.cwd}\`` : ""}.`,
        ].join("\n"),
  ];
  const hints = opts.hints;
  if (hints && (hints.touchedFiles?.length || hints.decisions?.length || hints.nextActions?.length || hints.openQuestions?.length)) {
    lines.push("", "Heuristic hints extracted mechanically (verify against the transcript, they are noisy):");
    if (hints.touchedFiles?.length) lines.push(`- files: ${hints.touchedFiles.join(", ")}`);
    if (hints.decisions?.length) lines.push(`- decision-like lines: ${hints.decisions.join(" | ")}`);
    if (hints.nextActions?.length) lines.push(`- next-action-like lines: ${hints.nextActions.join(" | ")}`);
    if (hints.openQuestions?.length) lines.push(`- question-like lines: ${hints.openQuestions.join(" | ")}`);
  }
  lines.push("", "--- transcript ---", transcript, "--- end transcript ---");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Local (heuristic) document

export interface CommandOutcome {
  command: string;
  outcome: "ok" | "failed" | "unknown";
  /** First error-looking line of the result, when it failed. */
  detail?: string;
}

export interface LocalHandoffContext {
  cwd?: string;
  gitBranch?: string;
  firstAsk?: string;
  recentCommands?: CommandOutcome[];
}

const FAILURE_LINE = /\b(error|errors|failed|failure|FAIL|exception|traceback|not found|denied|exit(?:ed)?(?: code)? [1-9]\d*|ENOENT|EACCES|panic|✗|×)\b/i;
const FAILURE_NEGATED = /\b(0 (errors?|failed|failures?)|no errors?|errors?: 0|failed: 0|without errors?)\b/i;

/** Did a command's result read as a failure? Cheap and wrong sometimes, so it says "ok"
 * or "failed" only when the text is clear and "unknown" otherwise. */
export function classifyCommandResult(status: string | undefined, output: unknown): { outcome: CommandOutcome["outcome"]; detail?: string } {
  if (status === "error") return { outcome: "failed", detail: oneLine(stringify(output), 120) || undefined };
  const text = stringify(output);
  if (!text.trim()) return { outcome: status === "completed" ? "ok" : "unknown" };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.find((l) => FAILURE_LINE.test(l) && !FAILURE_NEGATED.test(l));
  if (bad) return { outcome: "failed", detail: oneLine(bad, 120) };
  return { outcome: "ok" };
}

/** What the transcript records about its environment, without a model. */
export function localHandoffContext(messages: RawMessage[], cwd?: string): LocalHandoffContext {
  let gitBranch: string | undefined;
  let firstAsk: string | undefined;
  const commands: CommandOutcome[] = [];
  // Shell calls waiting for their result; results follow their calls in order.
  const pending: CommandOutcome[] = [];
  for (const m of messages) {
    const raw = m.raw as { gitBranch?: unknown } | undefined;
    if (raw && typeof raw.gitBranch === "string" && raw.gitBranch) gitBranch = raw.gitBranch;
    if (!firstAsk && m.role === "user" && m.text && !m.toolCalls?.length) {
      const cleaned = m.text.replace(/<(local-command-[a-z]+|system-reminder|task-notification)>[\s\S]*?<\/\1>/g, "").trim();
      if (cleaned) firstAsk = oneLine(cleaned, 240);
    }
    for (const tc of m.toolCalls ?? []) {
      if (tc.name === "(result)") {
        const waiting = pending.shift();
        if (waiting) Object.assign(waiting, classifyCommandResult(tc.status, tc.output));
        continue;
      }
      const input = tc.input as Record<string, unknown> | undefined;
      const command = input && typeof input === "object" ? input.command ?? input.cmd : undefined;
      if (typeof command !== "string" || !command.trim()) {
        // A non-shell tool still consumes the next result.
        if (tc.output === undefined) pending.push({ command: "", outcome: "unknown" });
        continue;
      }
      const entry: CommandOutcome = { command: oneLine(command, 160), outcome: "unknown" };
      if (tc.output !== undefined) Object.assign(entry, classifyCommandResult(tc.status, tc.output));
      else pending.push(entry);
      commands.push(entry);
    }
  }
  return { cwd, gitBranch, firstAsk, recentCommands: commands.slice(-8) };
}

export function renderLocalHandoff(s: HandoffSnapshot, ctx: LocalHandoffContext | string | undefined): string {
  const c: LocalHandoffContext = typeof ctx === "string" || ctx === undefined ? { cwd: ctx } : ctx;
  const cwd = c.cwd;
  const goal = [
    ...(c.firstAsk && c.firstAsk !== s.currentTask ? [`Original ask: ${c.firstAsk}`] : []),
    ...(s.currentTask ? [`${c.firstAsk && c.firstAsk !== s.currentTask ? "Latest ask: " : ""}${s.currentTask}`] : []),
  ];
  // A question is something the previous session asked; it is not an action for the next one.
  const nextActions = s.nextActions.filter((line) => !line.trim().endsWith("?"));
  const out: string[] = [
    "> local fallback: no agent CLI found to write this handoff; fields below are regex-extracted. Install claude or codex, or set AGENT_PEEK_HANDOFF_RUNNER.",
    "",
    "# Handoff",
    "",
    "## Goal",
    ...(goal.length ? goal : ["Unknown: no clear task line found in the transcript."]),
    "",
    "## Current state",
    `activity: ${s.activity}; ${s.messageCount} messages.`,
    ...(s.lastAssistantMessage ? [`Last assistant message: ${oneLine(s.lastAssistantMessage, 400)}`] : []),
    ...(s.pendingTools.length ? [`Pending tools: ${s.pendingTools.join(", ")}`] : []),
    "",
    "## Decisions and why",
    ...bullets(s.decisions),
    "",
    "## Files",
    ...bullets(s.touchedFiles),
    "",
    "## Open questions / blockers",
    ...bullets(s.openQuestions),
    "",
    "## Next actions",
    ...bullets(nextActions),
    "",
    "## Gotchas",
    ...(c.recentCommands?.some((cmd) => cmd.outcome === "failed")
      ? c.recentCommands.filter((cmd) => cmd.outcome === "failed").map((cmd) => `- \`${cmd.command}\` failed${cmd.detail ? `: ${cmd.detail}` : ""}`)
      : ["Unknown: not extractable without a model. The recent commands below show what was tried."]),
    "",
    "## Environment",
    cwd ? `cwd: ${cwd}` : "cwd: unknown",
    ...(c.gitBranch ? [`git branch: ${c.gitBranch}`] : []),
    ...(s.recentTools.length ? [`recent tools: ${s.recentTools.join(", ")}`] : []),
    ...(c.recentCommands?.length ? [
      "",
      "Recent commands (oldest first), with how their output read:",
      ...c.recentCommands.map((cmd) => `- \`${cmd.command}\` -> ${cmd.outcome}${cmd.detail ? `: ${cmd.detail}` : ""}`),
    ] : []),
  ];
  return out.join("\n");
}

function bullets(values: string[]): string[] {
  return values.length ? values.map((v) => `- ${v}`) : ["(none found)"];
}

// ---------------------------------------------------------------------------
// Runners: local agent CLIs run headless on the user's existing login

export interface ResolveRunnerOpts {
  adapter?: string;
  which?: (bin: string) => string | undefined;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

interface HarnessSpec {
  bin: string;
  adapters: string[];
  /** Flags that turn the CLI into a pure text-in, text-out call with nothing
   * that could recurse (hooks, MCP servers such as agent-peek itself) or
   * leave a transcript behind for peek to index as a real session. */
  args: string[];
}

// Order is the fallback order when the session's own harness is not installed.
// Only `claude` was verified against `--help` on this machine; the others use
// their documented non-interactive forms and read the prompt from stdin.
const HARNESSES: HarnessSpec[] = [
  { bin: "claude", adapters: ["claude-code"], args: ["-p", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--output-format", "text"] },
  { bin: "codex", adapters: ["codex"], args: ["exec", "--skip-git-repo-check", "-"] },
  { bin: "gemini", adapters: ["gemini"], args: ["-p", ""] },
  { bin: "opencode", adapters: ["opencode"], args: ["run"] },
  { bin: "copilot", adapters: ["copilot-cli"], args: ["-p", "-", "--silent"] },
];

const DEFAULT_RUNNER_TIMEOUT_MS = 180_000;

export function resolveHandoffRunner(opts: ResolveRunnerOpts = {}): HandoffRunner | undefined {
  const env = opts.env ?? process.env;
  const which = opts.which ?? whichOnPath;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;

  const override = env.AGENT_PEEK_HANDOFF_RUNNER?.trim();
  if (override) {
    const command = override.split(/\s+/);
    return makeRunner(command[0]!, command, opts.cwd, timeoutMs);
  }

  const own = HARNESSES.find((h) => opts.adapter && h.adapters.includes(opts.adapter));
  const ordered = own ? [own, ...HARNESSES.filter((h) => h !== own)] : HARNESSES;
  for (const h of ordered) {
    const path = which(h.bin);
    if (path) return makeRunner(h.bin, [path, ...h.args], opts.cwd, timeoutMs);
  }
  return undefined;
}

function makeRunner(name: string, command: string[], _sessionCwd: string | undefined, timeoutMs: number): HandoffRunner {
  // The prompt carries everything the model needs, so the child never runs in
  // the session's repo: that keeps it from picking up project settings, and a
  // cwd that no longer exists would make spawn fail with ENOENT.
  return {
    name,
    command,
    run: (prompt) => spawnWithStdin(command, prompt, { cwd: tmpdir(), timeoutMs }),
  };
}

/** Prompt goes over stdin: a compressed transcript can be 150k chars, past ARG_MAX. */
function spawnWithStdin(command: string[], input: string, opts: { cwd?: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = command;
    const child = spawn(bin!, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${bin} timed out after ${Math.round(opts.timeoutMs / 1000)}s`));
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited ${code}${err.trim() ? `: ${oneLine(err.trim(), 300)}` : ""}`));
    });
    child.stdin.on("error", () => { /* child exited early; close() reports it */ });
    child.stdin.end(input);
  });
}

/** Superset installs wrappers ahead of the real binaries. Its codex wrapper, run
 * headless, re-execs itself forever (observed: ~2,800 bash processes from one
 * `codex exec --help`), so the runner resolves past those directories the same
 * way the wrappers themselves do. */
export function isWrapperDir(dir: string): boolean {
  return /(^|\/)\.superset(-[^/]*)?\/bin\/?$/.test(dir);
}

function whichOnPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || isWrapperDir(dir)) continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Heuristic extractors (moved from snapshot.ts)

function extractLines(values: string[], pattern: RegExp, max: number): string[] {
  const lines: string[] = [];
  for (const value of values) {
    for (const line of splitCandidateLines(value)) {
      if (pattern.test(line)) lines.push(oneLine(line, 220));
    }
  }
  return uniqueStrings(lines).slice(-max);
}

function extractQuestions(values: string[], max: number): string[] {
  const questions: string[] = [];
  for (const value of values) {
    for (const line of splitCandidateLines(value)) {
      if (isOpenQuestion(line)) questions.push(oneLine(line, 220));
    }
  }
  return uniqueStrings(questions).slice(-max);
}

/**
 * A question someone still needs answered, as opposed to a rhetorical one ("Why does
 * this matter? Because...") or a code fragment that happens to end in "?". It has to
 * address someone or ask for a decision, and carry no code.
 */
function isOpenQuestion(line: string): boolean {
  if (/\b(blocked|need input|open question)\b/i.test(line)) return true;
  if (!line.endsWith("?") || line.includes("`") || line.length > 200) return false;
  if (line.split(/\s+/).length < 4) return false;
  return /\b(should|shall|want|do you|would you|could you|can you|ok(ay)? to|prefer|which|or)\b/i.test(line);
}

function splitCandidateLines(value: string): string[] {
  return value
    .split(/\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
}
