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
    await writeFile(join(projDir, "xyz.jsonl"),
      `{"type":"user","sessionId":"xyz","cwd":"/tmp/y","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","content":"hi"}}\n`,
      "utf8");

    const transport = new StdioClientTransport({
      command: "node",
      args: [BIN],
      env: { ...process.env, HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: "test", version: "0.0.1" }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      ["list_sessions", "peek_session", "tag_session"]);

    const res = await client.callTool({ name: "list_sessions", arguments: {} });
    const text = (res.content as any)?.[0]?.text ?? "[]";
    const list = JSON.parse(text);
    expect(Array.isArray(list)).toBe(true);
    expect(list.find((e: any) => e.id === "claude-code:xyz")).toBeTruthy();

    await client.close();
  }, 15_000);
});
