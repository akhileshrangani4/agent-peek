// test/adapters/opencode.test.ts
import { describe, it, expect } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import opencode from "../../src/adapters/opencode/index.js";
import { withEnv } from "../helpers/tmp-home.js";

describe("opencode adapter", () => {
  it("scans and reads filesystem storage", async () => {
    const data = await mkdtemp(join(tmpdir(), "opencode-data-"));
    const storage = join(data, "opencode", "storage");
    await mkdir(join(storage, "session", "proj-1"), { recursive: true });
    await mkdir(join(storage, "message", "ses_1"), { recursive: true });
    await mkdir(join(storage, "part", "msg_1"), { recursive: true });
    await mkdir(join(storage, "part", "msg_2"), { recursive: true });

    await writeFile(join(storage, "session", "proj-1", "ses_1.json"), JSON.stringify({
      id: "ses_1",
      directory: "/tmp/repo",
      title: "Work",
      time: { created: 1770000000000, updated: 1770000002000 },
    }), "utf8");
    await writeFile(join(storage, "message", "ses_1", "msg_1.json"), JSON.stringify({
      id: "msg_1",
      role: "user",
      time: { created: 1770000000000 },
    }), "utf8");
    await writeFile(join(storage, "part", "msg_1", "prt_1.json"), JSON.stringify({
      id: "prt_1",
      type: "text",
      text: "fix auth",
    }), "utf8");
    await writeFile(join(storage, "message", "ses_1", "msg_2.json"), JSON.stringify({
      id: "msg_2",
      role: "assistant",
      time: { created: 1770000001000 },
    }), "utf8");
    await writeFile(join(storage, "part", "msg_2", "prt_2.json"), JSON.stringify({
      id: "prt_2",
      type: "tool",
      tool: "read",
      state: { status: "completed", input: { path: "auth.ts" }, output: "ok" },
    }), "utf8");

    await withEnv({ XDG_DATA_HOME: data }, async () => {
      const sessions = await opencode.scan();
      expect(sessions.length).toBe(1);
      expect(sessions[0]!.id).toBe("opencode:ses_1");
      expect(sessions[0]!.name).toBe("work");
      expect(sessions[0]!.cwd).toBe("/tmp/repo");
      const r = await opencode.read(sessions[0]!);
      expect(r.messages[0]!.role).toBe("user");
      expect(r.messages[0]!.text).toBe("fix auth");
      expect(r.messages[1]!.role).toBe("assistant");
      expect(r.messages[1]!.toolCalls?.[0]?.name).toBe("read");
      expect(r.messages[1]!.toolCalls?.[0]?.output).toBe("ok");
    });
  });
});
