import { describe, it, expect } from "vitest";
import { toBrief, toRaw, toStructured, toSummary } from "../../src/core/snapshot.js";
import { toHandoff } from "../../src/core/handoff.js";
import type { RawMessage } from "../../src/core/types.js";
import { withEnv } from "../helpers/tmp-home.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const msgs = (): RawMessage[] => [
  { role: "user", text: "do X", raw: {} },
  { role: "assistant", text: "starting", raw: {} },
  { role: "assistant", text: undefined, toolCalls: [{ name: "Read", input: { p: "f" }, status: "pending" }], raw: {} },
  { role: "tool", text: undefined, toolCalls: [{ name: "(result)", output: "contents", status: "completed" }], raw: {} },
  { role: "assistant", text: "done", raw: {} },
];

describe("snapshot.toRaw", () => {
  it("passes through messages", () => {
    const s = toRaw("sid", msgs());
    expect(s.mode).toBe("raw");
    expect(s.sessionId).toBe("sid");
    expect(s.messages.length).toBe(5);
  });

  it("respects limit", () => {
    const s = toRaw("sid", msgs(), { limit: 2 });
    expect(s.messages.length).toBe(2);
    // tail of 2 = last 2 messages
    expect(s.messages[1]!.text).toBe("done");
    expect(s.window).toEqual({ start: 3, end: 5, order: "oldest-first" });
  });

  it("supports first, offset, around, and newest-first windows", () => {
    expect(toRaw("sid", msgs(), { limit: 2, from: "start" }).messages.map((m) => m.text)).toEqual(["do X", "starting"]);
    expect(toRaw("sid", msgs(), { limit: 2, offset: 1 }).messages.map((m) => m.text)).toEqual([undefined, undefined]);
    expect(toRaw("sid", msgs(), { limit: 3, around: 2 }).window).toEqual({ start: 0, end: 3, order: "oldest-first" });
    expect(toRaw("sid", msgs(), { limit: 2, order: "newest-first" }).messages.map((m) => m.text)).toEqual(["done", undefined]);
  });
});

describe("snapshot.toStructured", () => {
  it("derives lastUser/lastAssistant + counts", () => {
    const s = toStructured("sid", msgs());
    expect(s.mode).toBe("structured");
    expect(s.messageCount).toBe(5);
    expect(s.lastUserMessage).toBe("do X");
    expect(s.lastAssistantMessage).toBe("done");
  });

  it("sees Claude Code's file_path and notebook_path as touched files", () => {
    const s = toStructured("sid", [
      { role: "assistant", toolCalls: [{ name: "Read", input: { file_path: "/work/repo/src/a.ts" }, status: "completed" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "NotebookEdit", input: { notebook_path: "/work/repo/nb.ipynb", new_source: "x" }, status: "completed" }], raw: {} },
    ], "/work/repo");
    expect(s.touchedFiles).toEqual(["/work/repo/nb.ipynb", "/work/repo/src/a.ts"]);
    expect(s.writingFiles).toEqual(["/work/repo/nb.ipynb"]);
  });

  it("marks only a shell command's write targets as writing, not every path in it", () => {
    // Command-derived paths count only when they are on disk, so the fixture is real.
    const repo = mkdtempSync(join(tmpdir(), "ap-snap-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "bin"), { recursive: true });
    for (const f of ["src/a.ts", "src/d.ts", "src/e.ts", "bin/peek.js"]) writeFileSync(join(repo, f), "x");
    const run = (command: string) => toStructured("sid", [
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command }, status: "completed" }], raw: {} },
    ], repo);
    // Running a script and redirecting its output writes the target, not the script.
    let s = run(`node bin/peek.js list --json > ${repo}/out.json`);
    expect(s.writingFiles).toEqual([`${repo}/out.json`]);
    expect(s.touchedFiles).toContain(`${repo}/bin/peek.js`);
    // Reading a file writes nothing, even when the command mentions words like "add".
    s = run("cat src/a.ts && git add src/a.ts && git commit -m 'add tests'");
    expect(s.writingFiles).toEqual([]);
    // Operand-based writers: the operand is the target; cp/mv write only their destination.
    s = run("cp src/a.ts src/b.ts && touch src/c.ts && sed -i '' 's/x/y/' src/d.ts && rm src/e.ts");
    expect(s.writingFiles).toEqual([`${repo}/src/b.ts`, `${repo}/src/c.ts`, `${repo}/src/d.ts`, `${repo}/src/e.ts`]);
    // Heredoc into a file writes the file; input redirect does not.
    s = run("cat <<'EOF' > src/f.ts\nhello\nEOF\nwc -l < src/a.ts");
    expect(s.writingFiles).toEqual([`${repo}/src/f.ts`]);
    // Code inside a command is not a redirect: `=>` is an arrow, `$VAR/x` is unexpanded,
    // `bin/peek.js.` ends a sentence. None of these are files anyone wrote.
    s = run('node -e "const f = (w) => !w.startsWith(1); xs.some((other) => other.id)" > $D/out.err 2>&1; grep -n "admitAppRun(app.id))" src/a.ts; echo done bin/peek.js.');
    expect(s.writingFiles).toEqual([]);
    expect(s.touchedFiles).toEqual([`${repo}/src/a.ts`, `${repo}/bin/peek.js`].sort());
    s = run(`cat a.txt 2>/dev/null >${repo}/log.txt && ls -> ${repo}/arrow.txt`);
    expect(s.writingFiles).toEqual([`${repo}/log.txt`]);
    // apply_patch headers name their files.
    s = run("apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/g.ts\n*** End Patch\nEOF");
    expect(s.writingFiles).toEqual([`${repo}/src/g.ts`]);
    rmSync(repo, { recursive: true, force: true });
  });

  it("includes touched and writing file context", () => {
    const s = toStructured("sid", [
      { role: "user", text: "edit", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Edit", input: { path: "src/a.ts" }, status: "pending" }], raw: {} },
    ], "/repo");
    expect(s.touchedFiles).toEqual(["/repo/src/a.ts"]);
    expect(s.writingFiles).toEqual(["/repo/src/a.ts"]);
  });

  it("excludes tool result placeholders from recent tools", () => {
    const s = toStructured("sid", msgs());
    expect(s.lastToolCalls.map((tool) => tool.name)).toEqual(["Read"]);
  });

  it("activity tool-running while a tool_use is unanswered", () => {
    const m: RawMessage[] = [
      { role: "user", text: "x", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Bash", status: "pending" }], raw: {} },
    ];
    const s = toStructured("sid", m);
    expect(s.activity).toBe("tool-running");
    expect(s.pendingToolCalls.length).toBe(1);
  });

  it("activity thinking when last is assistant text", () => {
    const m: RawMessage[] = [
      { role: "user", text: "x", raw: {} },
      { role: "assistant", text: "considering", raw: {} },
    ];
    expect(toStructured("s", m).activity).toBe("thinking");
  });

  it("activity idle when last is user", () => {
    const m: RawMessage[] = [{ role: "user", text: "x", raw: {} }];
    expect(toStructured("s", m).activity).toBe("idle");
  });

  it("currentTask prefers the user's ask over the assistant's narration", () => {
    const s = toStructured("sid", [
      { role: "user", text: "Okay now let's fix the 5815 error in the daemon.", raw: {} },
      { role: "assistant", text: "Let me see how the other daemons in that directory actually get run.", raw: {} },
      { role: "assistant", text: "Now I'll check the launchd plist.", raw: {} },
    ]);
    expect(s.currentTask).toBe("Okay now let's fix the 5815 error in the daemon.");
  });

  it("currentTask is the user's words even without an action verb, minus harness wrappers", () => {
    let s = toStructured("sid", [
      { role: "user", text: "ci is failing on this", raw: {} },
      { role: "assistant", text: "The script now resolves the write from its own location. Let me check the workflow.", raw: {} },
    ]);
    expect(s.currentTask).toBe("ci is failing on this");
    s = toStructured("sid", [
      { role: "user", text: "<local-command-stdout>ok</local-command-stdout>\n<system-reminder>ignore</system-reminder>\ncheck the review comment on 5811", raw: {} },
      { role: "assistant", text: "Let me look at the review comment.", raw: {} },
    ]);
    expect(s.currentTask).toBe("check the review comment on 5811");
  });

  it("currentTask and lastUserMessage skip harness-injected user turns and reach the human one", () => {
    const s = toStructured("sid", [
      { role: "user", text: "yes third, this time spin off codex too", raw: {} },
      { role: "assistant", text: "I'll fix it with the batch: first the runner.", raw: {} },
      { role: "user", text: "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<task-id>abc</task-id>\n</task-notification>\n</system-reminder>", raw: {} },
      { role: "user", text: "Base directory for this skill: /x/y\n\n# Skill\nTo harness a new trigger word, add one entry to LEXICON.", raw: {} },
      { role: "assistant", text: "Now I need to update the tests.", raw: {} },
    ]);
    expect(s.lastUserMessage).toBe("yes third, this time spin off codex too");
    expect(s.currentTask).toBe("yes third, this time spin off codex too");
  });

  it("currentTask is not truncated with an ellipsis; renderers shorten it", () => {
    const long = "Please " + "refactor the uploader module ".repeat(12).trim();
    const s = toStructured("sid", [{ role: "user", text: long, raw: {} }]);
    expect(s.currentTask).toBe(long);
    expect(s.currentTask).not.toMatch(/\.\.\.$/);
  });

  it("command-derived touched paths must exist on disk; tool arguments need not", () => {
    const here = process.cwd();
    const s = toStructured("sid", [
      { role: "assistant", toolCalls: [{ name: "Bash", input: { command: "cat src/a.ts src/core/engine.ts && grep foo ./cursor.js" }, status: "completed" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "Write", input: { file_path: `${here}/src/brand-new.ts`, content: "x" }, status: "completed" }], raw: {} },
    ], here);
    expect(s.touchedFiles).toEqual([`${here}/src/brand-new.ts`, `${here}/src/core/engine.ts`]);
    expect(s.writingFiles).toEqual([`${here}/src/brand-new.ts`]);
  });

  it("currentTask falls back to the assistant's objective when the user turn is not actionable", () => {
    const s = toStructured("sid", [
      { role: "user", text: "Add a retry to the uploader.", raw: {} },
      { role: "assistant", text: "I'll add a retry loop to the uploader.", raw: {} },
      { role: "user", text: "yes", raw: {} },
      { role: "assistant", text: "Now I need to update the tests for the retry.", raw: {} },
    ]);
    expect(s.currentTask).toBe("Now I need to update the tests for the retry.");
  });

  it("currentTask comes from last user message (heuristic)", () => {
    const s = toStructured("sid", msgs());
    expect(s.currentTask).toBe("do X");
  });
});

describe("snapshot.toBrief", () => {
  it("creates a local non-LLM summary", () => {
    const s = toBrief("sid", msgs());
    expect(s.mode).toBe("brief");
    expect(s.brief).toMatch(/Task: do X/);
    expect(s.brief).toMatch(/Last assistant: done/);
    expect(s.recentTools).toContain("Read");
  });
});

describe("snapshot.toHandoff", () => {
  it("extracts local handoff fields", () => {
    const s = toHandoff("sid", [
      { role: "system", text: "AskUserQuestion/Question: present choices?", raw: {} },
      { role: "user", text: "Can you add resources?", raw: {} },
      { role: "assistant", text: "Implemented MCP resources. Next I will add prompts.", raw: {} },
      { role: "assistant", toolCalls: [{ name: "Read", input: { path: "src/mcp/index.ts" }, status: "pending" }], raw: {} },
      // A path scraped from a shell command counts only when it is on disk; this one is.
      { role: "assistant", toolCalls: [{ name: "exec_command", input: { cmd: `cat "${process.cwd()}/src/core/engine.ts"` }, status: "pending" }], raw: {} },
      { role: "assistant", toolCalls: [{ name: "exec_command", input: { cmd: "curl https://example.com/foo/bar && echo Content-Type: application/json" }, status: "pending" }], raw: {} },
    ], process.cwd());
    expect(s.mode).toBe("handoff");
    expect(s.decisions).toContain("Implemented MCP resources.");
    expect(s.nextActions).toContain("Next I will add prompts.");
    expect(s.openQuestions).toContain("Can you add resources?");
    expect(s.openQuestions).not.toContain("AskUserQuestion/Question: present choices?");
    expect(s.touchedFiles).toEqual([`${process.cwd()}/src/core/engine.ts`, `${process.cwd()}/src/mcp/index.ts`]);
    expect(s.recentTools).toContain("Read");
  });
});

describe("snapshot.toSummary", () => {
  it("creates a no-dependency local summary when no API key is configured", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "", AGENT_PEEK_SUMMARY_PROVIDER: "" }, async () => {
      const s = await toSummary("sid", [{ role: "user", text: "hi", raw: {} }], { deltaMessageCount: 1 });
      expect(s.mode).toBe("summary");
      expect(s.fallback).toBeFalsy();
      expect(s.structured).toBeUndefined();
      expect(s.summary).toMatch(/Current task: hi/);
    });
  });

  it("does not pick the anthropic provider from ANTHROPIC_API_KEY alone", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedProvider = process.env.AGENT_PEEK_SUMMARY_PROVIDER;
    try {
      process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
      delete process.env.AGENT_PEEK_SUMMARY_PROVIDER;
      const s = await toSummary("sid", msgs(), { deltaMessageCount: 5, cacheKey: "k-privacy" });
      expect(s.fallback ?? false).toBe(false); // local is the primary path, not a fallback
      expect(s.summary.length).toBeGreaterThan(0);
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
      if (savedProvider === undefined) delete process.env.AGENT_PEEK_SUMMARY_PROVIDER;
      else process.env.AGENT_PEEK_SUMMARY_PROVIDER = savedProvider;
    }
  });

  it("can force the local summary provider even when an Anthropic key is present", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "test-key", AGENT_PEEK_SUMMARY_PROVIDER: "local" }, async () => {
      const s = await toSummary("sid", msgs(), { deltaMessageCount: 5 });
      expect(s.summary).toMatch(/Current task: do X/);
      expect(s.summary).toMatch(/Recent tools: Read/);
    });
  });

  it("calls anthropic client when key present", async () => {
    let captured: any = null;
    const mockClient = {
      messages: {
        create: async (req: any) => {
          captured = req;
          return { content: [{ type: "text", text: "Agent is doing X." }] };
        },
      },
    };
    const s = await toSummary(
      "sid",
      [{ role: "user", text: "do X", raw: {} }],
      { deltaMessageCount: 1, client: mockClient as any, model: "claude-haiku-4-5" },
    );
    expect(s.summary).toBe("Agent is doing X.");
    expect(s.fallback).toBeFalsy();
    expect(captured.model).toBe("claude-haiku-4-5");
  });

  it("caches by (sessionId, cursor) for 60s", async () => {
    let calls = 0;
    const mockClient = {
      messages: {
        create: async () => { calls++; return { content: [{ type: "text", text: "x" }] }; },
      },
    };
    const m = [{ role: "user" as const, text: "a", raw: {} }];
    await toSummary("sid", m, { deltaMessageCount: 1, client: mockClient as any, cacheKey: "k1" });
    await toSummary("sid", m, { deltaMessageCount: 1, client: mockClient as any, cacheKey: "k1" });
    expect(calls).toBe(1);
  });
});
