// test/app/doctor.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  commandExists, doctorEnv, doctorRows, opencodeDatabaseRow, probeStateDir, shellQuote, type DoctorEnv,
} from "../../src/app/doctor.js";
import { makeTmpHome, withEnv } from "../helpers/tmp-home.js";

describe("doctorRows", () => {
  let home: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => { ({ home, cleanup } = await makeTmpHome()); });
  afterEach(async () => { await cleanup(); });

  function env(overrides: Partial<DoctorEnv> = {}, commands: readonly string[] = []): DoctorEnv {
    return {
      home,
      xdgData: join(home, ".local", "share"),
      platform: "linux",
      commandExists: async (command) => commands.includes(command),
      opencodeDatabases: () => ({ existing: [] }),
      ...overrides,
    };
  }

  const byAdapter = (rows: Awaited<ReturnType<typeof doctorRows>>) => rows.map((row) => [row.adapter, row.source, row.status]);

  it("reports every source missing on an empty machine, in the recorded order", async () => {
    expect(byAdapter(await doctorRows(env()))).toEqual([
      ["claude-code", "file", "not found"],
      ["codex", "file", "not found"],
      ["copilot-cli", "directory", "not found"],
      ["gemini", "file", "not found"],
      ["goose", "database", "not found"],
      ["opencode", "directory", "not found"],
      ["opencode", "database", "not found"],
      ["tmux", "terminal", "needs command"],
      ["screen", "terminal", "needs command"],
    ]);
  });

  it("marks present sources ready and installed terminals opt-in", async () => {
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    mkdirSync(join(home, ".local", "share", "opencode", "storage"), { recursive: true });
    const rows = await doctorRows(env({}, ["tmux", "screen"]));
    expect(rows.find((row) => row.adapter === "claude-code")).toEqual({
      adapter: "claude-code", source: "file", path: join(home, ".claude", "projects"), status: "ready",
    });
    expect(rows.find((row) => row.adapter === "opencode" && row.source === "directory")!.status).toBe("ready");
    expect(rows.filter((row) => row.source === "terminal").map((row) => row.status)).toEqual(["opt-in", "opt-in"]);
  });

  it("keeps the Goose row's recorded wording, needing sqlite3 only once a database exists", async () => {
    const dir = join(home, ".local", "share", "goose", "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sessions.db"), "");
    const missing = (await doctorRows(env())).find((row) => row.adapter === "goose")!;
    expect(missing).toMatchObject({ status: "needs command", command: "sqlite3", note: "sqlite3 required to query Goose sessions" });
    expect((await doctorRows(env({}, ["sqlite3"]))).find((row) => row.adapter === "goose")!.status).toBe("ready");
  });

  it("looks for Goose under APPDATA on Windows", async () => {
    const appData = join(home, "AppData");
    const row = (await doctorRows(env({ platform: "win32", appData }))).find((r) => r.adapter === "goose")!;
    expect(row.path).toBe(join(appData, "Block", "goose", "data", "sessions", "sessions.db"));
  });
});

describe("opencodeDatabaseRow", () => {
  it("says why there is no database when OPENCODE_DB is in-memory", () => {
    expect(opencodeDatabaseRow({ existing: [] })).toEqual({
      adapter: "opencode", source: "database", status: "not found", note: "OPENCODE_DB=:memory: keeps no database on disk",
    });
  });

  it("reports the primary database and the channel databases also read", () => {
    expect(opencodeDatabaseRow({ primary: "/d/opencode.db", existing: [] }))
      .toEqual({ adapter: "opencode", source: "database", path: "/d/opencode.db", status: "not found", note: undefined });
    expect(opencodeDatabaseRow({ primary: "/d/opencode.db", existing: ["/d/opencode.db", "/d/opencode-beta.db"] }))
      .toMatchObject({ status: "ready", note: "also reading opencode-beta.db" });
  });
});

describe("environment probes", () => {
  it("resolves the doctor environment from HOME and XDG_DATA_HOME", async () => {
    await withEnv({ HOME: "/h", XDG_DATA_HOME: "/xdg" }, () => {
      const resolved = doctorEnv();
      expect(resolved.home).toBe("/h");
      expect(resolved.xdgData).toBe("/xdg");
      expect(resolved.platform).toBe(process.platform);
    });
  });

  it("probes the state directory for writability", async () => {
    const { home, cleanup } = await makeTmpHome();
    try {
      expect(probeStateDir(home)).toEqual({ path: join(home, ".agent-peek"), writable: true });
      const blocked = join(home, "blocked");
      mkdirSync(blocked);
      writeFileSync(join(blocked, ".agent-peek"), "not a directory");
      const probe = probeStateDir(blocked);
      expect(probe.writable).toBe(false);
      expect(probe.error).toMatch(/^E[A-Z]+$/);
    } finally {
      await cleanup();
    }
  });

  it("finds a command that runs, and not one that does not exist", async () => {
    expect(await commandExists(process.execPath)).toBe(true);
    expect(await commandExists("agent-peek-no-such-command-xyz")).toBe(false);
  });

  it("quotes a value for a POSIX shell", () => {
    expect(shellQuote("tmux")).toBe("'tmux'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
