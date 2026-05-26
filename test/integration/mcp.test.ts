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
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ["coordination_digest", "list_sessions", "peek_session", "tag_session"]);

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
});
