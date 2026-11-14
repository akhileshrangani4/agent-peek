import { describe, it, expect } from "vitest";
import {
  buildHandoff,
  compressTranscript,
  renderHandoffPrompt,
  resolveHandoffRunner,
  parseHandoffTarget,
  isWrapperDir,
  localHandoffContext,
} from "../../src/core/handoff.js";
import { classifyFileEvents } from "../../src/core/file-events.js";
import type { RawMessage, ToolCall } from "../../src/core/types.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const msgs = (): RawMessage[] => [
  { role: "user", text: "Add MCP resources for handoffs", raw: {} },
  { role: "assistant", text: "Implemented MCP resources. Next I will add prompts.", raw: {} },
  { role: "assistant", toolCalls: [{ name: "Read", input: { file_path: "/work/repo/src/mcp/index.ts" }, status: "completed" }], raw: {} },
  { role: "tool", toolCalls: [{ name: "(result)", output: "x".repeat(2000), status: "completed" }], raw: {} },
  { role: "assistant", text: "Should I also add prompts?", raw: {} },
];

describe("handoff.compressTranscript", () => {
  it("keeps user and assistant text, collapses tool calls, truncates results", () => {
    const out = compressTranscript(msgs(), { budgetChars: 100_000 });
    expect(out).toContain("[user] Add MCP resources for handoffs");
    expect(out).toContain("[assistant] Implemented MCP resources.");
    expect(out).toContain("tool=Read");
    expect(out).toContain("/work/repo/src/mcp/index.ts");
    // 2000-char tool output is cut to the result cap, not dropped
    expect(out).toMatch(/x{100,}/);
    expect(out).not.toMatch(/x{600,}/);
  });

  it("keeps the head and the tail when over budget, marking the gap", () => {
    const many: RawMessage[] = [];
    for (let i = 0; i < 200; i++) many.push({ role: "user", text: `message number ${i} ${"y".repeat(200)}`, raw: {} });
    const out = compressTranscript(many, { budgetChars: 8_000 });
    expect(out.length).toBeLessThanOrEqual(8_500);
    expect(out).toContain("message number 0 ");
    expect(out).toContain("message number 199 ");
    expect(out).toMatch(/\[\.\.\. \d+ messages omitted \.\.\.\]/);
    // tail keeps more than head: the opening carries the ask, the tail carries the state
    const head = out.indexOf("[... ");
    expect(out.length - head).toBeGreaterThan(head);
  });

  it("drops system messages", () => {
    const out = compressTranscript([{ role: "system", text: "hidden prompt", raw: {} }], { budgetChars: 1000 });
    expect(out).not.toContain("hidden prompt");
  });
});

describe("handoff.renderHandoffPrompt", () => {
  it("frames CLI targets around a filesystem and chat targets around inline excerpts", () => {
    const cli = renderHandoffPrompt("T", { target: "claude-code", cwd: "/work/repo" });
    expect(cli).toContain("/work/repo");
    expect(cli).toMatch(/filesystem|shell/i);
    expect(cli).toContain("## Next actions");

    const chat = renderHandoffPrompt("T", { target: "chatgpt", cwd: "/work/repo" });
    expect(chat).toMatch(/cannot (read|open) files|no filesystem/i);
    expect(chat).toMatch(/inline|excerpt/i);
  });

  it("passes heuristic hints through so the model can verify them", () => {
    const p = renderHandoffPrompt("T", { target: "generic", hints: { touchedFiles: ["/a/b.ts"], decisions: ["chose X"] } });
    expect(p).toContain("/a/b.ts");
    expect(p).toContain("chose X");
  });
});

describe("handoff.parseHandoffTarget", () => {
  it("accepts known targets and aliases, rejects others", () => {
    expect(parseHandoffTarget(undefined)).toBe("generic");
    expect(parseHandoffTarget("claude-code")).toBe("claude-code");
    expect(parseHandoffTarget("claude")).toBe("claude-code");
    expect(parseHandoffTarget("ChatGPT")).toBe("chatgpt");
    expect(parseHandoffTarget("nope")).toBeUndefined();
  });
});

describe("handoff.resolveHandoffRunner", () => {
  it("prefers the env override, then the session's own harness, then any installed harness", () => {
    const which = (bin: string) => (bin === "codex" || bin === "claude" ? `/bin/${bin}` : undefined);
    expect(resolveHandoffRunner({ adapter: "codex", which, env: {} })?.name).toBe("codex");
    expect(resolveHandoffRunner({ adapter: "gemini", which, env: {} })?.name).toBe("claude");
    expect(resolveHandoffRunner({ adapter: "codex", which, env: { AGENT_PEEK_HANDOFF_RUNNER: "my-llm --stdin" } })?.command)
      .toEqual(["my-llm", "--stdin"]);
    expect(resolveHandoffRunner({ adapter: "codex", which: () => undefined, env: {} })).toBeUndefined();
  });

  it("runs claude headless with hooks, MCP and session persistence off", () => {
    const r = resolveHandoffRunner({ adapter: "claude-code", which: (b) => (b === "claude" ? "/bin/claude" : undefined), env: {} });
    expect(r?.command).toContain("--no-session-persistence");
    expect(r?.command).toContain("--strict-mcp-config");
    expect(r?.command).toContain("--setting-sources");
  });
});

describe("handoff.isWrapperDir", () => {
  it("skips Superset wrapper directories and nothing else", () => {
    expect(isWrapperDir("/Users/avi/.superset/bin")).toBe(true);
    expect(isWrapperDir("/Users/avi/.superset-staging/bin/")).toBe(true);
    expect(isWrapperDir("/Users/avi/.local/bin")).toBe(false);
    expect(isWrapperDir("/opt/homebrew/bin")).toBe(false);
    expect(isWrapperDir("/Users/avi/.superset/worktrees/x/bin")).toBe(false);
  });
});

describe("handoff.buildHandoff", () => {
  it("uses the injected runner and reports the harness provider", async () => {
    let seen = "";
    const s = await buildHandoff("sid", msgs(), {
      cwd: "/work/repo",
      target: "codex",
      runner: { name: "fake", command: ["fake"], run: async (prompt) => { seen = prompt; return "# Handoff\n\nfrom fake"; } },
    });
    expect(s.mode).toBe("handoff");
    expect(s.provider).toBe("harness");
    expect(s.runner).toBe("fake");
    expect(s.document).toBe("# Handoff\n\nfrom fake");
    expect(seen).toContain("Add MCP resources for handoffs");
    // heuristic fields survive for existing consumers
    expect(s.nextActions).toContain("Next I will add prompts.");
    // "Implemented MCP resources." is a bare outcome, not a decision (D9.3).
    expect(s.decisions).toEqual([]);
    expect(s.touchedFiles).toEqual(["/work/repo/src/mcp/index.ts"]);
  });

  it("falls back to a local document, with a visible header, when there is no runner", async () => {
    const s = await buildHandoff("sid", msgs(), { cwd: "/work/repo", target: "generic", runner: undefined });
    expect(s.provider).toBe("local");
    expect(s.document).toMatch(/^> local fallback/m);
    expect(s.document).toContain("## Next actions");
    expect(s.document).toContain("Next I will add prompts.");
    expect(s.document).toContain("src/mcp/index.ts");
  });

  it("local handoff carries branch, first ask, recent commands, and no questions as next actions", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "<system-reminder>noise</system-reminder>\nAdd retries to the uploader.", raw: { gitBranch: "avi/retries" } },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm test -- uploader" }, status: "completed" }], raw: { gitBranch: "avi/retries" } },
      { role: "assistant", text: "Next I will wire the backoff. Want me to also add jitter?", raw: {} },
      { role: "user", text: "ci is failing on this", raw: { gitBranch: "avi/retries" } },
    ], { cwd: "/work/repo", target: "generic", produce: "local" });
    // D9.4: Goal is the session goal; the current ask, when it differs, leads Current state.
    expect(s.document).toMatch(/## Goal\nAdd retries to the uploader\.\n\n## Current state\nCurrent ask: ci is failing on this\n/);
    expect(s.document).toMatch(/git branch: avi\/retries/);
    expect(s.document).toMatch(/Recent commands \(oldest first\), with how their output read:\n- `npm test -- uploader` -> unknown/);
    // The question moves to Open questions; it is not an action for the next session.
    expect(s.document).toMatch(/## Next actions\n- Next I will wire the backoff\.\n\n## Gotchas/);
    // The user's next turn answered it, so it is not open either (D9.3).
    expect(s.document).toMatch(/## Open questions \/ blockers\n\(none found\)/);
  });

  it("open questions keep real questions and drop rhetoric and code fragments", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "Should we keep the old flag or remove it?", raw: {} },
      { role: "assistant", text: "A quiet hint under the secondary button when a rare case needs a sentence: `Own this app?", raw: {} },
      { role: "assistant", text: "Why does this matter? Because the cache is shared.", raw: {} },
      { role: "assistant", text: "Do you want me to also add jitter?", raw: {} },
    ], { cwd: "/work/repo", target: "generic", produce: "local" });
    // The user's question was answered by the turns after it; the trailing offer was not.
    expect(s.openQuestions).toEqual(["Do you want me to also add jitter?"]);
  });

  // D9.4 (Research E §6): goal and current ask stay distinct through the handoff.
  it("carries goal separately from currentTask and renders both", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "Land feature #1578 and the doc follow-ups.", raw: {} },
      { role: "assistant", text: "I'll start with the prompt files.", raw: {} },
      { role: "user", text: "the .env.local got committed", raw: {} },
      { role: "assistant", text: "I'll remove it from tracking, gitignore it, and rewrite the commit.", raw: {} },
      { role: "user", text: "yes", raw: {} },
      { role: "assistant", text: "Right — let me use peek's own capability instead of hand-authoring.", raw: {} },
    ], { cwd: "/x", target: "generic", produce: "local" });
    expect(s.goal).toBe("Land feature #1578 and the doc follow-ups.");
    expect(s.currentTask).toBe("the .env.local got committed");
    expect(s.document).toMatch(/## Goal\nLand feature #1578 and the doc follow-ups\.\n\n## Current state\nCurrent ask: the \.env\.local got committed\n/);
    // The assistant's narration never stands in for the goal or the ask.
    expect(s.document).not.toContain("let me use peek's own capability\n\n## Current state");
    expect(s.currentTask).not.toContain("let me use peek");
  });

  it("a single-ask handoff has no separate Current ask line", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "Add retries to the uploader.", raw: {} },
      { role: "assistant", text: "Working on it.", raw: {} },
    ], { cwd: "/x", target: "generic", produce: "local" });
    expect(s.goal).toBe(s.currentTask);
    expect(s.document).toMatch(/## Goal\nAdd retries to the uploader\.\n\n## Current state\nactivity:/);
    expect(s.document).not.toContain("Current ask:");
  });

  // D9.3 (Research E §1): a question the other party replied to is settled; an early
  // blocker nobody replied to is still open, however much work followed it.
  it("open questions are the unanswered ones: answered drop, an early unanswered blocker stays", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "Move the plan doc somewhere sensible.", raw: {} },
      { role: "assistant", text: "Should I put the plan under docs/superpowers/plans or docs/plans?", raw: {} },
      { role: "user", text: "docs/plans", raw: {} },
      { role: "assistant", text: "Moved it. What do you think?", raw: {} },
      { role: "user", text: "looks good, ship it", raw: {} },
      { role: "assistant", text: "Blocked: I need the staging deploy key before I can publish the docs site.", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run build" }, status: "completed" }], raw: {} },
      { role: "assistant", text: "Built the site locally.", raw: {} },
    ], { cwd: "/x", target: "generic", produce: "local" });
    expect(s.openQuestions).toEqual(["Blocked: I need the staging deploy key before I can publish the docs site."]);
  });

  // D9.3 (Research E §2), with the owner's decision on trailing offers.
  it("narration and bare outcomes are not decisions; an answered request is not open; a trailing offer is", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "Write a handoff for this session.", raw: {} },
      { role: "assistant", text: "Let me run peek at first.", raw: {} },
      { role: "user", text: "can you not use peek to create a handoff?", raw: {} },
      { role: "assistant", text: "Using peek to capture session context, then I'll write the handoff. I added the handoff file. Anything else? Would you like me to also commit it?", raw: {} },
    ], { cwd: "/x", target: "generic", produce: "local" });
    expect(s.decisions).toEqual([]);
    expect(s.nextActions).toEqual([]);
    expect(s.openQuestions).toEqual(["Would you like me to also commit it?"]);
    expect(s.document).toMatch(/## Decisions and why\n\(none found\)/);
    expect(s.document).toMatch(/## Open questions \/ blockers\n- Would you like me to also commit it\?\n\n/);
  });

  it("local handoff says how each recent command's output read, and lists failures as gotchas", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "Fix the tests.", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm test" }, status: "completed" }], raw: {} },
      { role: "tool", toolCalls: [{ name: "(result)", output: "Tests 2 failed | 40 passed\nFAIL test/a.test.ts > does x", status: "completed" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "Read", input: { file_path: "/x/a.ts" }, status: "completed" }], raw: {} },
      { role: "tool", toolCalls: [{ name: "(result)", output: "file contents with the word error in prose", status: "completed" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm test" }, status: "completed" }], raw: {} },
      { role: "tool", toolCalls: [{ name: "(result)", output: "Tests 42 passed (42)\n0 failed", status: "completed" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "git push" }, status: "pending" }], raw: {} },
    ], { cwd: "/x", target: "generic", produce: "local" });
    expect(s.document).toMatch(/- `npm test` -> failed: Tests 2 failed \| 40 passed/);
    expect(s.document).toMatch(/- `npm test` -> ok\n/);
    expect(s.document).toMatch(/- `git push` -> unknown/);
    expect(s.document).toMatch(/## Gotchas\n- `npm test` failed: Tests 2 failed/);
    // The Read result was not attributed to a shell command.
    expect(s.document).not.toMatch(/word error in prose/);
  });

  it("next actions and decisions come from the current ask, not from finished tasks", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "Add the retry loop.", raw: {} },
      { role: "assistant", text: "Implemented the retry loop rather than a queue. Next I will add jitter.", raw: {} },
      { role: "user", text: "Now fix the failing CI job.", raw: {} },
      { role: "assistant", text: "Pinned the matrix to Node 24 because the runner image moved. Next I need to rerun CI.", raw: {} },
    ], { cwd: "/x", target: "generic", produce: "local" });
    expect(s.nextActions).toEqual(["Next I need to rerun CI."]);
    expect(s.decisions).toEqual(["Pinned the matrix to Node 24 because the runner image moved."]);
  });

  it("a result flagged as an error is failed regardless of wording; chat targets keep longer excerpts", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "<command-name>/clear</command-name><command-message>clear</command-message>", raw: {} },
      { role: "user", text: "Ship the toast.", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "sed -n '1,5p' a.test.ts" }, status: "completed", id: "a" }], raw: {} },
      { role: "tool", toolCalls: [{ name: "(result)", output: "it('renders Error toast', ...)", status: "completed", id: "a" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm test" }, status: "error", id: "b" }], raw: {} },
      { role: "tool", toolCalls: [{ name: "(result)", output: "all fine here honestly", status: "error", id: "b" }], raw: {} },
    ], { cwd: "/x", target: "generic", produce: "local" });
    expect(s.document).toMatch(/## Goal\nShip the toast\./);
    expect(s.document).toMatch(/- `sed -n '1,5p' a\.test\.ts` -> ok/);
    expect(s.document).toMatch(/- `npm test` -> failed: all fine here honestly/);

    const long = "x".repeat(1200);
    const msgs2: RawMessage[] = [
      { role: "user", text: "Explain it.", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Read", input: { file_path: "/x/a.ts" }, status: "completed", id: "r" }], raw: {} },
      { role: "tool", toolCalls: [{ name: "(result)", output: long, status: "completed", id: "r" }], raw: {} },
    ];
    const cli = await buildHandoff("sid", msgs2, { target: "claude-code", produce: "material" });
    const chat = await buildHandoff("sid", msgs2, { target: "chatgpt", produce: "material" });
    expect(cli.material).toMatch(/x{300}\.\.\. \(\+900 chars\)/);
    expect(chat.material).toMatch(/x{1200}/);
    expect(chat.material).toMatch(/cut to about 1500 characters/);
  });

  it("a commit title containing the word error is not a failed command", async () => {
    const s = await buildHandoff("sid", [
      { role: "user", text: "Commit it.", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "git commit -m 'fix(cli): errors under --json are JSON'" }, status: "completed" }], raw: {} },
      { role: "tool", toolCalls: [{ name: "(result)", output: "[main abc123] fix(cli): errors under --json are JSON\n 2 files changed", status: "completed" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "npm run build" }, status: "completed" }], raw: {} },
      { role: "tool", toolCalls: [{ name: "(result)", output: "src/x.ts(3,1): error TS2322: Type 'a' is not assignable", status: "completed" }], raw: {} },
    ], { cwd: "/x", target: "generic", produce: "local" });
    expect(s.document).toMatch(/- `git commit -m 'fix\(cli\): errors under --json are JSON'` -> ok/);
    expect(s.document).toMatch(/- `npm run build` -> failed: src\/x\.ts\(3,1\): error TS2322/);
  });

  it("labels a deliberately local handoff as such instead of as a fallback", async () => {
    const s = await buildHandoff("sid", msgs(), { cwd: "/work/repo", target: "generic", produce: "local" });
    expect(s.provider).toBe("local");
    expect(s.document).toMatch(/^> regex handoff \(--local\)/m);
    expect(s.document).not.toMatch(/local fallback|Install claude/);
  });

  it("falls back to local when the runner throws, and says why", async () => {
    const s = await buildHandoff("sid", msgs(), {
      cwd: "/work/repo",
      target: "generic",
      runner: { name: "fake", command: ["fake"], run: async () => { throw new Error("boom"); } },
    });
    expect(s.provider).toBe("local");
    expect(s.document).toContain("boom");
  });

  it("returns material for the host model instead of running anything when produce=material", async () => {
    const s = await buildHandoff("sid", msgs(), {
      cwd: "/work/repo",
      target: "claude-code",
      produce: "material",
      runner: { name: "fake", command: ["fake"], run: async () => { throw new Error("must not run"); } },
    });
    expect(s.provider).toBe("host");
    expect(s.material).toContain("Add MCP resources for handoffs");
    expect(s.material).toContain("## Next actions");
    expect(s.document).toMatch(/^> you are the harness: write the handoff from `material`/m);
    expect(s.document).not.toMatch(/Install claude/);
  });
});

// ---------------------------------------------------------------------------
// D9.2 (#1) and D9.1 (#7): which files the session wrote versus only read, and
// where each written file ended up, checked against the disk at handoff time.

/** A temp checkout (a `.git` directory at its root) holding the given files. */
function checkout(files: string[], dirs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "ap-handoff-"));
  mkdirSync(join(root, ".git"));
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "x\n");
  }
  return root;
}

const run = (name: string, input: unknown, extra: Partial<ToolCall> = {}): RawMessage => ({
  role: "assistant",
  toolCalls: [{ name, input, status: "completed", ...extra }],
  raw: {},
});

const filesSection = (document: string) => document.split("## Files\n")[1]?.split("\n\n")[0];

/** Research E §1: a plan written, then `git mv`'d; two questions, each answered next turn. */
function section1Session(ws: string): RawMessage[] {
  const plan = "docs/superpowers/plans/2026-06-25-buildy-content-prompt.md";
  return [
    { role: "user", text: "Write the content-prompt plan for buildy.", raw: {} },
    { role: "assistant", text: "Should I put the plan under docs/superpowers/plans or docs/plans?", raw: {} },
    { role: "user", text: "docs/plans", raw: {} },
    run("Write", { file_path: join(ws, plan), content: "# Plan" }),
    run("Bash", { command: `git mv ${plan} docs/plans/new-plan.md` }),
    { role: "assistant", text: "Moved the plan to docs/plans/new-plan.md. What do you think?", raw: {} },
    { role: "user", text: "looks good, ship it", raw: {} },
  ];
}

describe("handoff file roles and end state (#1, D9.2)", () => {
  it("lists a git mv'd plan once, at its destination, with the source marked moved", async () => {
    // On disk after the session: the destination, and the emptied source directory.
    const ws = checkout(["docs/plans/new-plan.md"], ["docs/superpowers/plans"]);
    const source = join(ws, "docs/superpowers/plans/2026-06-25-buildy-content-prompt.md");
    const destination = join(ws, "docs/plans/new-plan.md");
    expect(classifyFileEvents(section1Session(ws), ws)).toEqual([
      { path: destination, relPath: "docs/plans/new-plan.md", role: "wrote", state: "created" },
      { path: source, relPath: "docs/superpowers/plans/2026-06-25-buildy-content-prompt.md", role: "wrote", state: "moved", movedTo: destination },
    ]);
    const s = await buildHandoff("sid", section1Session(ws), { cwd: ws, target: "generic", produce: "local" });
    expect(filesSection(s.document)).toBe([
      "- docs/plans/new-plan.md (created)",
      "- docs/superpowers/plans/2026-06-25-buildy-content-prompt.md (moved to docs/plans/new-plan.md)",
    ].join("\n"));
    // Both questions were answered by the user's next turn (#1, questions half).
    expect(s.openQuestions).toEqual([]);
    // touchedFiles keeps its 0.6 meaning: every path any call touched.
    expect(s.touchedFiles).toContain(destination);
  });

  it("still marks the source moved when its directory is gone too", () => {
    // The session wrote the source itself, so the move needs no on-disk evidence for it.
    const ws = checkout(["docs/plans/new-plan.md"]);
    const destination = join(ws, "docs/plans/new-plan.md");
    expect(classifyFileEvents(section1Session(ws), ws)).toEqual([
      { path: destination, relPath: "docs/plans/new-plan.md", role: "wrote", state: "created" },
      { path: join(ws, "docs/superpowers/plans/2026-06-25-buildy-content-prompt.md"), relPath: "docs/superpowers/plans/2026-06-25-buildy-content-prompt.md", role: "wrote", state: "moved", movedTo: destination },
    ]);
  });

  it("ignores a move or delete of a path it has no evidence for", () => {
    const ws = checkout([], ["src"]);
    expect(classifyFileEvents([
      run("Bash", { command: "mv gone/a.ts gone/b.ts && rm gone/c.ts" }),
    ], ws)).toEqual([]);
  });

  it("folds a plain mv: the source is moved, the destination carries the write", () => {
    const ws = checkout(["src/b.ts", "src/existing.ts"]);
    const files = classifyFileEvents([
      run("Write", { file_path: "src/a.ts", content: "x" }),
      run("Bash", { command: "mv src/a.ts src/b.ts" }),
      run("Edit", { file_path: "src/existing.ts", old_string: "a", new_string: "b" }),
    ], ws);
    expect(files).toEqual([
      { path: join(ws, "src/a.ts"), relPath: "src/a.ts", role: "wrote", state: "moved", movedTo: join(ws, "src/b.ts") },
      { path: join(ws, "src/b.ts"), relPath: "src/b.ts", role: "wrote", state: "created" },
      { path: join(ws, "src/existing.ts"), relPath: "src/existing.ts", role: "wrote", state: "modified" },
    ]);
  });

  it("follows a chain of moves to where the file ended up", () => {
    const ws = checkout(["src/c.ts"]);
    const files = classifyFileEvents([
      run("Write", { file_path: "src/a.ts", content: "x" }),
      run("Bash", { command: "git mv src/a.ts src/b.ts && git mv src/b.ts src/c.ts" }),
    ], ws);
    expect(files.find((file) => file.relPath === "src/a.ts")).toMatchObject({ state: "moved", movedTo: join(ws, "src/c.ts") });
    expect(files.find((file) => file.relPath === "src/b.ts")).toMatchObject({ state: "moved", movedTo: join(ws, "src/c.ts") });
    expect(files.find((file) => file.relPath === "src/c.ts")).toMatchObject({ role: "wrote", state: "created" });
  });

  it("marks a file written then rm'd as deleted, not live", async () => {
    const ws = checkout(["src/keep.ts"]);
    const messages: RawMessage[] = [
      { role: "user", text: "Try a scratch file then clean up.", raw: {} },
      run("Write", { file_path: "src/scratch.ts", content: "x" }),
      run("Edit", { file_path: "src/keep.ts", old_string: "a", new_string: "b" }),
      run("Bash", { command: "rm -f src/scratch.ts" }),
    ];
    expect(classifyFileEvents(messages, ws)).toEqual([
      { path: join(ws, "src/keep.ts"), relPath: "src/keep.ts", role: "wrote", state: "modified" },
      { path: join(ws, "src/scratch.ts"), relPath: "src/scratch.ts", role: "wrote", state: "deleted" },
    ]);
    const s = await buildHandoff("sid", messages, { cwd: ws, target: "generic", produce: "local" });
    expect(filesSection(s.document)).toBe("- src/keep.ts (modified)\n- src/scratch.ts (deleted)");
  });

  it("marks a file edited then git rm'd as deleted; git rm --cached leaves it live", () => {
    const ws = checkout(["src/cached.ts"], ["src"]);
    const files = classifyFileEvents([
      run("Edit", { file_path: "src/old.ts", old_string: "a", new_string: "b" }),
      run("Bash", { command: "git rm -q src/old.ts" }),
      run("Edit", { file_path: "src/cached.ts", old_string: "a", new_string: "b" }),
      run("Bash", { command: "git rm --cached src/cached.ts" }),
    ], ws);
    expect(files).toEqual([
      { path: join(ws, "src/cached.ts"), relPath: "src/cached.ts", role: "wrote", state: "modified" },
      { path: join(ws, "src/old.ts"), relPath: "src/old.ts", role: "wrote", state: "deleted" },
    ]);
  });

  it("lets the disk have the last word at handoff time", () => {
    const ws = checkout(["src/back.ts"], ["src"]);
    const files = classifyFileEvents([
      // Written, then removed by something the transcript never shows.
      run("Write", { file_path: "src/gone.ts", content: "x" }),
      // Deleted, then restored the same way.
      run("Bash", { command: "rm src/back.ts" }),
    ], ws);
    expect(files).toEqual([
      { path: join(ws, "src/back.ts"), relPath: "src/back.ts", role: "wrote", state: "modified" },
      { path: join(ws, "src/gone.ts"), relPath: "src/gone.ts", role: "wrote", state: "deleted" },
    ]);
  });

  it("re-creates a file written where one was deleted, and keeps the first verdict on rewrites", () => {
    const ws = checkout(["src/a.ts", "src/n.ts"]);
    const files = classifyFileEvents([
      run("Bash", { command: "rm src/a.ts" }),
      run("Write", { file_path: "src/a.ts", content: "x" }),
      run("Write", { file_path: "src/n.ts", content: "x" }),
      run("Edit", { file_path: "src/n.ts", old_string: "x", new_string: "y" }),
    ], ws);
    expect(files.map((file) => [file.relPath, file.role === "wrote" ? file.state : file.role])).toEqual([
      ["src/a.ts", "created"],
      ["src/n.ts", "created"],
    ]);
  });

  it("treats a file the session read first, then wrote, as modified", () => {
    const ws = checkout(["src/a.ts"]);
    const files = classifyFileEvents([
      run("Read", { file_path: "src/a.ts" }),
      run("Write", { file_path: "src/a.ts", content: "x" }),
    ], ws);
    expect(files).toEqual([{ path: join(ws, "src/a.ts"), relPath: "src/a.ts", role: "wrote", state: "modified" }]);
  });

  it("reads apply_patch headers: Add creates, Update modifies, Move to moves, Delete deletes", () => {
    const ws = checkout(["src/new.ts", "src/edited.ts", "src/renamed.ts"], ["src"]);
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** Update File: src/edited.ts",
      "@@",
      "-a",
      "+b",
      "*** Update File: src/moved.ts",
      "*** Move to: src/renamed.ts",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    const files = classifyFileEvents([run("apply_patch", { patch })], ws);
    expect(files.map((file) => [file.relPath, file.role === "wrote" ? file.state : file.role])).toEqual([
      ["src/dead.ts", "deleted"],
      ["src/edited.ts", "modified"],
      ["src/moved.ts", "moved"],
      ["src/new.ts", "created"],
      ["src/renamed.ts", "modified"],
    ]);
  });

  it("treats a move out of the checkout as a delete and a move in as a new file", () => {
    const ws = checkout(["src/in.ts"], ["src"]);
    const outside = mkdtempSync(join(tmpdir(), "ap-outside-"));
    writeFileSync(join(outside, "from.ts"), "x\n");
    const files = classifyFileEvents([
      run("Bash", { command: `mv src/out.ts ${outside}/out.ts` }),
      run("Bash", { command: `mv ${outside}/from.ts src/in.ts` }),
    ], ws);
    expect(files).toEqual([
      { path: join(ws, "src/in.ts"), relPath: "src/in.ts", role: "wrote", state: "created" },
      { path: join(ws, "src/out.ts"), relPath: "src/out.ts", role: "wrote", state: "deleted" },
    ]);
  });

  it("renders written files first, then one capped line of reads", async () => {
    const reads = Array.from({ length: 25 }, (_, i) => `docs/r${String(i).padStart(2, "0")}.md`);
    const ws = checkout(["src/a.ts", ...reads]);
    const s = await buildHandoff("sid", [
      { role: "user", text: "Update a.ts after reading the docs.", raw: {} },
      ...reads.map((file) => run("Read", { file_path: file })),
      run("Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
    ], { cwd: ws, target: "generic", produce: "local" });
    const section = filesSection(s.document)!;
    expect(section.split("\n")[0]).toBe("- src/a.ts (modified)");
    expect(section.split("\n")[1]).toBe(`Also read: ${reads.slice(0, 20).join(", ")} (+5 more)`);
  });

  it("says no files were written when the session only read", async () => {
    const ws = checkout(["src/real.ts"]);
    const s = await buildHandoff("sid", [
      { role: "user", text: "Where is createApp defined?", raw: {} },
      run("Bash", { command: "rg createApp src/real.ts" }),
    ], { cwd: ws, target: "generic", produce: "local" });
    expect(filesSection(s.document)).toBe("(no files written)\nAlso read: src/real.ts");
  });

  it("shows the absolute path for a file outside any repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ap-norepo-"));
    writeFileSync(join(dir, "notes.md"), "x\n");
    const s = await buildHandoff("sid", [
      { role: "user", text: "Tidy the notes file.", raw: {} },
      run("Edit", { file_path: "notes.md", old_string: "a", new_string: "b" }),
    ], { cwd: dir, target: "generic", produce: "local" });
    expect(filesSection(s.document)).toBe(`- ${join(dir, "notes.md")} (modified)`);
    rmSync(dir, { recursive: true, force: true });
  });

  // Research E §7: the Files section reflects the per-call cwd fix end to end.
  it("renders the section 7 session's real edits as written and its reads as read", async () => {
    const ws = checkout(["apps/server/src/apps/service.ts", "apps/server/src/mcp/tools.ts", "docs/_template.md", "src/real.ts", "src/apps/service.ts"]);
    const s = await buildHandoff("sid", [
      { role: "user", text: "Rename createApp in the server.", raw: {} },
      run("Read", { file_path: "docs/_template.md" }),
      run("Bash", { command: "rg createApp src/real.ts" }),
      run("Bash", { command: "cd apps/server && sed -i 's/old/new/' src/apps/service.ts" }),
      run("exec_command", { cmd: "sed -i 's/old/new/' src/mcp/tools.ts", workdir: join(ws, "apps/server") }),
    ], { cwd: ws, target: "generic", produce: "local" });
    expect(filesSection(s.document)).toBe([
      "- apps/server/src/apps/service.ts (modified)",
      "- apps/server/src/mcp/tools.ts (modified)",
      "Also read: docs/_template.md, src/real.ts",
    ].join("\n"));
    expect(s.document).not.toMatch(/^- src\/apps\/service\.ts/m);
  });
});

// Command outcomes pair a result with its call by id where the adapter records one.
describe("handoff command outcomes", () => {
  const call = (command: string, id?: string): RawMessage => run("Bash", { command }, id ? { id, status: "pending" } : { status: "pending" });
  const result = (output: string, id?: string, status: ToolCall["status"] = "completed"): RawMessage => ({
    role: "tool",
    toolCalls: [{ name: "(result)", output, status, ...(id ? { id } : {}) }],
    raw: {},
  });

  it("pairs results by id even when they arrive out of order", () => {
    const ctx = localHandoffContext([
      call("npm test", "a"),
      call("npm run lint", "b"),
      result("lint ok", "b"),
      result("Error: 2 tests failed", "a", "error"),
    ]);
    expect(ctx.recentCommands).toEqual([
      { command: "npm test", outcome: "failed", detail: expect.any(String) },
      { command: "npm run lint", outcome: "ok" },
    ]);
  });

  it("falls back to order for results without ids, and for an id no call carries", () => {
    const ctx = localHandoffContext([
      call("first"),
      call("second"),
      result("one"),
      result("two", "unknown-id"),
    ]);
    expect(ctx.recentCommands?.map((entry) => entry.outcome)).toEqual(["ok", "ok"]);
  });

  it("does not let an unmatched id settle a call that has its own id", () => {
    const ctx = localHandoffContext([call("waiting", "a"), result("stray", "z")]);
    expect(ctx.recentCommands).toEqual([{ command: "waiting", outcome: "unknown" }]);
  });
});
