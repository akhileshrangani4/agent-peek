// test/golden/mcp.golden.test.ts
//
// D3.1 baseline, MCP half: what the stdio server (`agent-peek-mcp`) returns for each of
// its 12 tools and 3 prompts on the golden fixture home, plus its `tools/list` and
// `prompts/list`. D3 moves the tool definitions into one registry shared with HTTP; this
// suite is how that move proves names, argument schemas and result shapes stayed
// byte-compatible.
//
// The list snapshots record only the 0.6.0 entries (see projectOntoBaseline): D5 adds
// `claim_files`, `graph_*` and friends to stdio, and the Compatibility table allows
// additions, so a new tool must not touch the golden. Removing, renaming or reshaping a
// 0.6.0 tool or prompt does change it, and fails.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CODEX_SESSION, assertFixtureCwdsAbsent, makeFixtureHome, type FixtureHome } from "./fixture-home.js";
import { MCP_BIN, assertDistFresh, expectGolden, projectOntoBaseline, runCli, structure } from "./harness.js";
import { Normalizer } from "./normalize.js";

/** The stdio tools 0.6.0 registers, in registration order. */
export const MCP_TOOLS_0_6 = [
  "peek_session", "list_sessions", "coordination_digest", "tag_session", "post_to_feed", "read_feed",
  "expand_post", "usage_report", "skills_report", "skill_detail", "archive_plan", "list_agents",
] as const;

/** The stdio prompts 0.6.0 registers. */
export const MCP_PROMPTS_0_6 = ["coordinate-agents", "session-handoff", "avoid-overlap"] as const;

type ToolName = (typeof MCP_TOOLS_0_6)[number];

interface ToolCase {
  /** Golden file name: `__snapshots__/mcp/tool-<name>.json`. */
  name: string;
  tool: ToolName;
  /** Arguments; a function sees the fixture and earlier results (e.g. the post id). */
  args: Record<string, unknown> | ((ctx: { fixture: FixtureHome; results: Map<string, ToolOutcome> }) => Record<string, unknown>);
}

/** A tool call either returns a result (possibly `isError`) or the server rejects it. */
type ToolOutcome =
  | { result: { isError: boolean; content: unknown[] } }
  | { rejected: { code: unknown; message: string } };

const CODEX = `codex:${CODEX_SESSION}`;

const TOOL_CASES: ToolCase[] = [
  { name: "list-sessions-all", tool: "list_sessions", args: { includeEnded: true } },
  { name: "list-sessions-active", tool: "list_sessions", args: {} },
  { name: "peek-raw-default", tool: "peek_session", args: { selector: "claude-code:s1" } },
  { name: "peek-raw-window", tool: "peek_session", args: { selector: "claude-code:s1", last: 2 } },
  { name: "peek-structured", tool: "peek_session", args: { selector: CODEX, mode: "structured" } },
  { name: "peek-brief", tool: "peek_session", args: { selector: "claude-code:s2", mode: "brief" } },
  { name: "peek-summary", tool: "peek_session", args: { selector: CODEX, mode: "summary" } },
  { name: "peek-handoff", tool: "peek_session", args: { selector: CODEX, mode: "handoff" } },
  { name: "peek-unknown", tool: "peek_session", args: { selector: "claude-code:missing" } },
  { name: "coordination-digest", tool: "coordination_digest", args: { cwd: "/tmp/repo", includeEnded: true } },
  { name: "tag-session", tool: "tag_session", args: { id: "claude-code:s1", tag: "mcp-main" } },
  { name: "peek-by-tag", tool: "peek_session", args: { selector: "mcp-main", mode: "brief" } },
  {
    name: "post-to-feed",
    tool: "post_to_feed",
    args: ({ fixture }) => ({ type: "finding", title: "Auth lives in auth.ts", text: "login() is defined in auth.ts", paths: ["auth.ts"], topics: ["auth"], as: "golden-mcp", dir: fixture.project }),
  },
  { name: "post-to-feed-invalid", tool: "post_to_feed", args: ({ fixture }) => ({ type: "finding", title: "No paths", text: "findings need paths", dir: fixture.project }) },
  { name: "read-feed", tool: "read_feed", args: ({ fixture }) => ({ dir: fixture.project }) },
  {
    name: "expand-post",
    tool: "expand_post",
    args: ({ fixture, results }) => ({ post_id: postIdFrom(results.get("post-to-feed")), dir: fixture.project }),
  },
  { name: "usage-report", tool: "usage_report", args: {} },
  { name: "usage-report-all-tools", tool: "usage_report", args: { groupBy: "tool", allTools: true } },
  { name: "skills-report", tool: "skills_report", args: {} },
  { name: "skill-detail", tool: "skill_detail", args: { skill: "golden-skill" } },
  { name: "archive-plan", tool: "archive_plan", args: { skill: "idle-skill" } },
  { name: "list-agents", tool: "list_agents", args: {} },
];

const PROMPT_CASES: { name: string; prompt: (typeof MCP_PROMPTS_0_6)[number]; args: Record<string, string> }[] = [
  { name: "coordinate-agents", prompt: "coordinate-agents", args: {} },
  { name: "session-handoff", prompt: "session-handoff", args: { selector: "claude-code:s1" } },
  { name: "avoid-overlap", prompt: "avoid-overlap", args: { cwd: "/tmp/repo" } },
];

function postIdFrom(outcome: ToolOutcome | undefined): string {
  if (!outcome || !("result" in outcome)) throw new Error("post-to-feed must succeed before expand-post");
  const first = outcome.result.content[0] as { text?: string } | undefined;
  return (JSON.parse(first?.text ?? "{}") as { id: string }).id;
}

/** Text content is parsed like CLI stdout: JSON when it is JSON, lines otherwise. */
function structureContent(content: unknown[]): unknown[] {
  return content.map((item) => {
    const entry = item as { type?: string; text?: unknown };
    return entry.type === "text" && typeof entry.text === "string" ? { ...entry, text: structure(entry.text) } : entry;
  });
}

describe("MCP stdio golden output (0.6.0 baseline)", () => {
  let fixture: FixtureHome;
  let normalizer: Normalizer;
  let client: Client;
  const results = new Map<string, ToolOutcome>();

  beforeAll(async () => {
    assertDistFresh();
    assertFixtureCwdsAbsent();
    fixture = await makeFixtureHome();
    normalizer = new Normalizer({ home: fixture.home, runStartedAt: Date.now(), stableIds: [CODEX_SESSION] });
    // The usage tools only read the index (an MCP call never builds it), so build it the
    // way a user does, with the CLI, before the server starts.
    const scan = runCli(["usage", "--json"], { cwd: fixture.project, env: fixture.env });
    if (scan.exit !== 0) throw new Error(`building the usage index failed: ${scan.stderr}`);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_BIN],
      env: fixture.env,
      cwd: fixture.project,
      stderr: "pipe",
    });
    client = new Client({ name: "golden", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await fixture?.cleanup();
  });

  it("tools/list keeps every 0.6.0 tool, unchanged", async () => {
    const { tools } = await client.listTools();
    const projection = projectOntoBaseline(tools, MCP_TOOLS_0_6);
    expect(projection.missing, "0.6.0 tools removed from tools/list").toEqual([]);
    await expectGolden("mcp", "tools-list", normalizer.value(projection.recorded));
  });

  it("prompts/list keeps every 0.6.0 prompt, unchanged", async () => {
    const { prompts } = await client.listPrompts();
    const projection = projectOntoBaseline(prompts, MCP_PROMPTS_0_6);
    expect(projection.missing, "0.6.0 prompts removed from prompts/list").toEqual([]);
    await expectGolden("mcp", "prompts-list", normalizer.value(projection.recorded));
  });

  it("covers every 0.6.0 tool and prompt", () => {
    const tools = new Set(TOOL_CASES.map((c) => c.tool));
    const prompts = new Set(PROMPT_CASES.map((c) => c.prompt));
    expect(MCP_TOOLS_0_6.filter((name) => !tools.has(name))).toEqual([]);
    expect(MCP_PROMPTS_0_6.filter((name) => !prompts.has(name))).toEqual([]);
  });

  for (const testCase of TOOL_CASES) {
    it(`tool ${testCase.name}`, async () => {
      const args = typeof testCase.args === "function" ? testCase.args({ fixture, results }) : testCase.args;
      let outcome: ToolOutcome;
      try {
        const res = await client.callTool({ name: testCase.tool, arguments: args });
        outcome = { result: { isError: res.isError === true, content: res.content as unknown[] } };
      } catch (err) {
        // A rejected call is behaviour too (unknown selector, invalid arguments); record
        // its code and message rather than failing the suite.
        const e = err as { code?: unknown; message?: string };
        outcome = { rejected: { code: e.code ?? null, message: e.message ?? String(err) } };
      }
      results.set(testCase.name, outcome);
      const recorded = "result" in outcome
        ? { result: { isError: outcome.result.isError, content: structureContent(outcome.result.content) } }
        : outcome;
      await expectGolden("mcp", `tool-${testCase.name}`, normalizer.value({ tool: testCase.tool, arguments: args, ...recorded }));
    });
  }

  for (const testCase of PROMPT_CASES) {
    it(`prompt ${testCase.name}`, async () => {
      const res = await client.getPrompt({ name: testCase.prompt, arguments: testCase.args });
      await expectGolden("mcp", `prompt-${testCase.name}`, normalizer.value({ prompt: testCase.prompt, arguments: testCase.args, result: res }));
    });
  }
});
