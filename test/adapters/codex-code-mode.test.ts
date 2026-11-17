// test/adapters/codex-code-mode.test.ts
//
// Current Codex (code mode) records shell commands and patches as a `custom_tool_call`
// named `exec` whose input is a JavaScript script calling `tools.<name>(…)`. These
// tests pin the reader that pulls those calls out without running the script, and the
// end-to-end path from such a record to `writingFiles` and the handoff's file roles.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codeModeCalls } from "../../src/adapters/codex/code-mode.js";
import codex from "../../src/adapters/codex/index.js";
import { parseRecord, type RawCodexRecord } from "../../src/adapters/codex/parse.js";
import { inferWritingFiles } from "../../src/core/coordination.js";
import { classifyFileEvents } from "../../src/core/file-events.js";
import { localHandoffContext } from "../../src/core/handoff.js";
import type { SessionEntry } from "../../src/core/types.js";

const exec = (input: string, callId = "call_1"): RawCodexRecord => ({
  type: "response_item",
  timestamp: "2026-11-13T00:00:00.000Z",
  payload: { type: "custom_tool_call", name: "exec", call_id: callId, input },
});

describe("codeModeCalls", () => {
  it("reads each tools.<name>(literal) call in source order", () => {
    const code = [
      "const a = await tools.exec_command({cmd:\"sed -i 's/a/b/' src/a.ts\", workdir:\"/repo/apps/server\", yield_time_ms: 1000});",
      "text(a);",
      "text(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: src/b.ts\\n*** End Patch\"));",
    ].join("\n");
    expect(codeModeCalls(code)).toEqual([
      { name: "exec_command", input: { cmd: "sed -i 's/a/b/' src/a.ts", workdir: "/repo/apps/server", yield_time_ms: 1000 } },
      { name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/b.ts\n*** End Patch" },
    ]);
  });

  it("decodes every literal kind and leaves computed arguments undefined", () => {
    expect(codeModeCalls("tools.x({'k': [1, -2.5e3, .5, true, false, null, `plain`], n: 0,})")).toEqual([
      { name: "x", input: { k: [1, -2500, 0.5, true, false, null, "plain"], n: 0 } },
    ]);
    expect(codeModeCalls("tools.x(cmd); tools.y({cmd}); tools.z(`cat ${f}`); tools.w({a: b}); tools.v('a' + b)")).toEqual([
      { name: "x" }, { name: "y" }, { name: "z" }, { name: "w" }, { name: "v" },
    ]);
    expect(codeModeCalls("tools.x([1 2]); tools.y({a 1}); tools.z({1a: 2}); tools.q('open")).toEqual([
      { name: "x" }, { name: "y" }, { name: "z", input: { "1a": 2 } }, { name: "q" },
    ]);
    expect(codeModeCalls("tools.a('x', {timeout: 5}); tools.b()")).toEqual([{ name: "a", input: "x" }, { name: "b" }]);
  });

  it("decodes string escapes", () => {
    expect(codeModeCalls(String.raw`tools.x("a\nb\tc\\d\"e\x41\u0042\u{1F600}\0\q")`)).toEqual([
      { name: "x", input: "a\nb\tc\\d\"eAB\u{1F600}\0q" },
    ]);
    expect(codeModeCalls("tools.x('a\\\nb'); tools.y(`a\\`b`)")).toEqual([{ name: "x", input: "ab" }, { name: "y", input: "a`b" }]);
    expect(codeModeCalls(String.raw`tools.x("\u{110000}\uZZ\xZ")`)).toEqual([{ name: "x", input: "u{110000}uZZxZ" }]);
  });

  it("ignores tools. text inside strings, comments and templates, but not inside ${…}", () => {
    const code = [
      "// tools.commented('a')",
      "/* tools.blocked('b') */",
      "const s = \"tools.quoted('c')\"; const t = 'tools.single(\\'d\\')';",
      "const u = `tools.templated('e') ${await tools.inner('f')} and ${ {a: 1}.a } tail`;",
      "mytools.notme('g'); tools.real('h');",
    ].join("\n");
    expect(codeModeCalls(code)).toEqual([{ name: "inner", input: "f" }, { name: "real", input: "h" }]);
    expect(codeModeCalls("tools . spaced('x'); tools.('y'); tools.name; /* open")).toEqual([]);
  });
});

describe("codex code-mode records", () => {
  it("turns one exec record into its nested calls, sharing the record's call id", () => {
    const message = parseRecord(exec("await tools.exec_command({cmd: 'ls'}); await tools.apply_patch('*** Begin Patch\\n*** End Patch');"));
    expect(message.role).toBe("assistant");
    expect(message.toolCalls).toEqual([
      { name: "exec_command", input: { cmd: "ls" }, status: "pending", id: "call_1" },
      { name: "apply_patch", input: { patch: "*** Begin Patch\n*** End Patch" }, status: "pending", id: "call_1" },
    ]);
  });

  it("keeps a script that calls no tool visible as exec, without its code", () => {
    expect(parseRecord(exec("text(1 + 1)")).toolCalls).toEqual([{ name: "exec", status: "pending", id: "call_1" }]);
    expect(parseRecord(exec("tools.view_image(path)", "")).toolCalls).toEqual([{ name: "view_image", status: "pending" }]);
  });

  it("joins the text items of a code-mode output and keeps its call id", () => {
    const output = parseRecord({
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_1", output: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] },
    });
    expect(output.toolCalls).toEqual([{ name: "(result)", output: "a\nb", status: "completed", id: "call_1" }]);
    const plain = parseRecord({ type: "response_item", payload: { type: "custom_tool_call_output", output: "done" } });
    expect(plain.toolCalls).toEqual([{ name: "(result)", output: "done", status: "completed" }]);
  });

  it("leaves other custom tools as unknown records", () => {
    expect(parseRecord({ type: "response_item", payload: { type: "custom_tool_call", name: "other", input: "x" } }).role).toBe("system");
  });

  // D9.1 on a current Codex rollout: the Research E §7 `workdir` edit, recorded in code mode.
  it("resolves a code-mode edit against its workdir, through the adapter, into writingFiles and file roles", async () => {
    const ws = mkdtempSync(join(tmpdir(), "ap-codex-ws-"));
    mkdirSync(join(ws, ".git"));
    for (const file of ["apps/server/src/mcp/tools.ts", "src/mcp/tools.ts", "docs/notes.md"]) {
      mkdirSync(join(ws, file, ".."), { recursive: true });
      writeFileSync(join(ws, file), "x\n");
    }
    const records: RawCodexRecord[] = [
      { type: "session_meta", payload: { cwd: ws } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Rename the tool." }] } },
      exec(`text(await tools.exec_command({cmd: "sed -i 's/a/b/' src/mcp/tools.ts", workdir: ${JSON.stringify(join(ws, "apps/server"))}}));`, "call_a"),
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call_a", output: [{ type: "text", text: "" }] } },
      exec("text(await tools.exec_command({cmd: 'cat docs/notes.md'}));", "call_b"),
    ];
    const path = join(mkdtempSync(join(tmpdir(), "ap-codex-")), "rollout.jsonl");
    writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    const entry: SessionEntry = { id: "codex:test", adapter: "codex", transcriptPath: path, cwd: ws, lastSeen: new Date().toISOString(), status: "active" };
    const { messages } = await codex.read(entry);

    expect(inferWritingFiles(messages, ws)).toEqual([join(ws, "apps/server/src/mcp/tools.ts")]);
    expect(classifyFileEvents(messages, ws).map((file) => [file.relPath, file.role])).toEqual([
      ["apps/server/src/mcp/tools.ts", "wrote"],
      ["docs/notes.md", "read"],
    ]);
    // The code-mode output settles its call by id, so the command reads as finished.
    expect(localHandoffContext(messages, ws).recentCommands).toEqual([
      { command: "sed -i 's/a/b/' src/mcp/tools.ts", outcome: "ok" },
      { command: "cat docs/notes.md", outcome: "unknown" },
    ]);
  });
});
