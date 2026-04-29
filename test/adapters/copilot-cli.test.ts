// test/adapters/copilot-cli.test.ts
import { describe, it, expect } from "vitest";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import copilotCli from "../../src/adapters/copilot-cli/index.js";
import { withEnv } from "../helpers/tmp-home.js";

describe("copilot-cli adapter", () => {
  it("scan finds session-state directories", async () => {
    const home = await makeCopilotHome();
    await withEnv({ HOME: home }, async () => {
      const sessions = await copilotCli.scan();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.id).toBe("copilot-cli:sess-a");
      expect(sessions[0]!.name).toBe("copilot-sess-a");
      expect(sessions[0]!.cwd).toBe("/tmp/repo");
    });
  });

  it("reads JSON and JSONL messages with cursor deltas", async () => {
    const home = await makeCopilotHome();
    const log = join(home, ".copilot", "session-state", "sess-a", "events.jsonl");
    await withEnv({ HOME: home }, async () => {
      const [session] = await copilotCli.scan();
      const r1 = await copilotCli.read(session!);
      expect(r1.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
      expect(r1.messages[0]!.text).toBe("fix auth");
      expect(r1.messages[1]!.text).toBe("I will inspect it.");

      await appendFile(log, `{"role":"assistant","content":"done"}\n`, "utf8");
      const r2 = await copilotCli.read(session!, r1.nextCursor);
      expect(r2.messages.length).toBe(1);
      expect(r2.messages[0]!.text).toBe("done");
    });
  });
});

async function makeCopilotHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "copilot-home-"));
  const dir = join(home, ".copilot", "session-state", "sess-a");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify({
    cwd: "/tmp/repo",
    messages: [
      { role: "user", content: "fix auth" },
      { role: "assistant", content: "I will inspect it." },
    ],
  }), "utf8");
  await writeFile(join(dir, "events.jsonl"), `{"role":"tool","content":"read auth.ts"}\n`, "utf8");
  return home;
}
