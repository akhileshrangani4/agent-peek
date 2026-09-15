import { describe, it, expect } from "vitest";
import {
  buildHandoff,
  compressTranscript,
  renderHandoffPrompt,
  resolveHandoffRunner,
  parseHandoffTarget,
  isWrapperDir,
} from "../../src/core/handoff.js";
import type { RawMessage } from "../../src/core/types.js";

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
    expect(s.decisions).toContain("Implemented MCP resources.");
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
    expect(s.document).toMatch(/## Goal\nOriginal ask: Add retries to the uploader\.\nLatest ask: ci is failing on this/);
    expect(s.document).toMatch(/git branch: avi\/retries/);
    expect(s.document).toMatch(/Recent commands \(oldest first\):\n- `npm test -- uploader`/);
    // The question moves to Open questions; it is not an action for the next session.
    expect(s.document).toMatch(/## Next actions\n- Next I will wire the backoff\.\n\n## Gotchas/);
    expect(s.document).toMatch(/## Open questions \/ blockers\n(- .*\n)*- Want me to also add jitter\?/);
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
