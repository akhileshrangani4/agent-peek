// test/integration/mcp.test.ts
import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(__dirname, "../../bin/agent-peek-mcp.js");

async function connectClient(home: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [BIN],
    env: { ...process.env, HOME: home } as Record<string, string>,
  });
  const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe("MCP integration", () => {
  it("lists tools and calls list_sessions", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-mcp-"));
    const projDir = join(home, ".claude", "projects", "-tmp-y");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "xyz.jsonl"), [
      `{"type":"user","sessionId":"xyz","cwd":"/tmp/y","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"inspect y"}}`,
      `{"type":"assistant","sessionId":"xyz","cwd":"/tmp/y","timestamp":"2026-01-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{"path":"src/y.ts"}}]}}`,
    ].join("\n") + "\n", "utf8");

    const transport = new StdioClientTransport({
      command: "node",
      args: [BIN],
      env: { ...process.env, HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "archive_plan", "coordination_digest", "expand_post", "list_agents", "list_sessions",
      "peek_session", "post_to_feed", "read_feed", "skill_detail", "skills_report",
      "tag_session", "usage_report",
    ]);
    // Nothing on this surface mutates a skill root: archive_plan returns a plan and the
    // command a human runs, and there is deliberately no archive or restore tool.
    expect(tools.tools.map((t) => t.name)).not.toContain("archive_skill");
    expect(tools.tools.map((t) => t.name)).not.toContain("restore_skill");

    const res = await client.callTool({ name: "list_sessions", arguments: {} });
    const text = (res.content as any)?.[0]?.text ?? "[]";
    const list = JSON.parse(text);
    expect(Array.isArray(list)).toBe(true);
    const session = list.find((e: any) => e.id === "claude-code:xyz");
    expect(session).toBeTruthy();
    expect(session.displayName).toBe("y-claude");

    const digestRes = await client.callTool({ name: "coordination_digest", arguments: { cwd: "/tmp/y" } });
    const digestText = (digestRes.content as any)?.[0]?.text ?? "{}";
    const digest = JSON.parse(digestText);
    expect(digest.mode).toBe("coordination");
    expect(digest.sessions[0].displayName).toBe("y-claude");

    const resources = await client.listResources();
    expect(resources.resources.map((resource) => resource.uri)).toContain("agent-peek://sessions");
    const briefResource = resources.resources.find((resource) => resource.uri.includes("claude-code%3Axyz") && resource.uri.endsWith("/brief"));
    const handoffResource = resources.resources.find((resource) => resource.uri.includes("claude-code%3Axyz") && resource.uri.endsWith("/handoff"));
    const tailResource = resources.resources.find((resource) => resource.uri.includes("claude-code%3Axyz") && resource.uri.endsWith("/tail"));
    expect(briefResource).toBeTruthy();
    expect(handoffResource).toBeTruthy();
    expect(tailResource).toBeTruthy();

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual([
      "agent-peek://session/{selector}/brief",
      "agent-peek://session/{selector}/handoff",
      "agent-peek://session/{selector}/tail",
    ]);

    const sessionsResource = await client.readResource({ uri: "agent-peek://sessions" });
    const sessionsText = (sessionsResource.contents as any)?.[0]?.text ?? "[]";
    expect(JSON.parse(sessionsText)[0].displayName).toBe("y-claude");

    const brief = await client.readResource({ uri: briefResource!.uri });
    const briefText = (brief.contents as any)?.[0]?.text ?? "{}";
    const briefResult = JSON.parse(briefText);
    expect(briefResult.snapshot.mode).toBe("brief");

    const handoff = await client.readResource({ uri: handoffResource!.uri });
    const handoffText = (handoff.contents as any)?.[0]?.text ?? "{}";
    expect(JSON.parse(handoffText).snapshot.mode).toBe("handoff");

    const tail = await client.readResource({ uri: tailResource!.uri });
    const tailText = (tail.contents as any)?.[0]?.text ?? "{}";
    expect(JSON.parse(tailText).snapshot.mode).toBe("raw");

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual(
      ["avoid-overlap", "coordinate-agents", "session-handoff"]);

    const prompt = await client.getPrompt({
      name: "session-handoff",
      arguments: { selector: "y-claude" },
    });
    const promptMessage = prompt.messages[0];
    expect(promptMessage).toBeTruthy();
    expect(promptMessage!.content.type).toBe("text");
    expect((promptMessage!.content as any).text).toMatch(/peek_session/);
    expect((promptMessage!.content as any).text).toMatch(/handoff/);

    const coordPrompt = await client.getPrompt({ name: "coordinate-agents", arguments: {} });
    expect((coordPrompt.messages[0]!.content as any).text).not.toMatch(/cwd="\\."/);

    await expect(client.getPrompt({
      name: "session-handoff",
      arguments: {},
    })).rejects.toThrow(/Missing required prompt argument/);

    await expect(client.callTool({
      name: "peek_session",
      arguments: { selector: "y-claude", mode: "invalid-mode" },
    })).rejects.toThrow(/invalid mode/);

    await client.close();
  }, 15_000);

  it("post_to_feed then read_feed round-trips", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-mcp-feed-"));
    const projectDir = await mkdtemp(join(tmpdir(), "ap-mcp-proj-"));
    const client = await connectClient(home);

    const posted = await client.callTool({
      name: "post_to_feed",
      arguments: {
        type: "finding", title: "t", text: "b", paths: ["src/a.ts"], as: "tester", dir: projectDir,
      },
    });
    expect(posted.isError).toBeFalsy();

    const feed = await client.callTool({
      name: "read_feed",
      arguments: { dir: projectDir, include_derived: false },
    });
    const parsed = JSON.parse((feed.content as any)[0].text);
    expect(parsed.items).toHaveLength(1);

    await client.close();
  }, 15_000);

  it("expand_post surfaces post_not_found as a tool error", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-mcp-feed-"));
    const projectDir = await mkdtemp(join(tmpdir(), "ap-mcp-proj-"));
    const client = await connectClient(home);

    const res = await client.callTool({
      name: "expand_post",
      arguments: { post_id: "missing", dir: projectDir },
    });
    expect(res.isError).toBe(true);

    await client.close();
  }, 15_000);

  it("lists the three feed tools and the feed resource", async () => {
    const home = await mkdtemp(join(tmpdir(), "ap-mcp-feed-"));
    const client = await connectClient(home);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    for (const name of ["post_to_feed", "read_feed", "expand_post"]) expect(names).toContain(name);

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain("agent-peek://feed");

    await client.close();
  }, 15_000);
});
