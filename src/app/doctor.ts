// src/app/doctor.ts
//
// `peek doctor`'s diagnosis: where each built-in adapter looks, whether that source
// exists, which commands it needs, and whether peek's own state directory is writable.
// The environment is injected so the rules can be tested without the caller's machine.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { opencodeDatabases } from "../adapters/opencode/index.js";

const execFileAsync = promisify(execFile);

export interface DoctorRow {
  adapter: string;
  source: string;
  status: "ready" | "not found" | "needs command" | "opt-in";
  path?: string;
  command?: string;
  note?: string;
}

export interface DoctorEnv {
  home: string;
  xdgData: string;
  platform: NodeJS.Platform;
  appData?: string;
  commandExists(command: string): Promise<boolean>;
  /** OpenCode V2's databases, resolved as the adapter resolves them. */
  opencodeDatabases(): { primary?: string; existing: string[] };
}

export function doctorEnv(): DoctorEnv {
  const home = process.env.HOME ?? homedir();
  return {
    home,
    xdgData: process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
    platform: process.platform,
    appData: process.env.APPDATA,
    commandExists,
    opencodeDatabases,
  };
}

export async function doctorRows(env: DoctorEnv = doctorEnv()): Promise<DoctorRow[]> {
  const { home } = env;
  const gooseDb = env.platform === "win32" && env.appData
    ? join(env.appData, "Block", "goose", "data", "sessions", "sessions.db")
    : join(home, ".local", "share", "goose", "sessions", "sessions.db");
  const gooseFound = existsSync(gooseDb);
  return [
    pathRow("claude-code", "file", join(home, ".claude", "projects")),
    pathRow("codex", "file", join(home, ".codex", "sessions")),
    pathRow("copilot-cli", "directory", join(home, ".copilot", "session-state")),
    pathRow("gemini", "file", join(home, ".gemini", "tmp")),
    {
      ...pathRow("goose", "database", gooseDb),
      command: "sqlite3",
      status: gooseFound ? await env.commandExists("sqlite3") ? "ready" : "needs command" : "not found",
      note: gooseFound ? "sqlite3 required to query Goose sessions" : undefined,
    },
    // The 0.6.0 row (legacy filesystem storage) keeps its shape; V2 gets an added row.
    pathRow("opencode", "directory", join(env.xdgData, "opencode", "storage")),
    opencodeDatabaseRow(env.opencodeDatabases()),
    {
      adapter: "tmux",
      source: "terminal",
      command: "tmux",
      status: await env.commandExists("tmux") ? "opt-in" : "needs command",
      note: "Use `peek list --terminals` or `--adapter tmux`; captures terminal scrollback.",
    },
    {
      adapter: "screen",
      source: "terminal",
      command: "screen",
      status: await env.commandExists("screen") ? "opt-in" : "needs command",
      note: "Use `peek list --terminals` or `--adapter screen`; captures terminal scrollback.",
    },
  ];
}

/** OpenCode V2's database row. Read through node:sqlite, so no command is needed. */
export function opencodeDatabaseRow(dbs: { primary?: string; existing: string[] }): DoctorRow {
  if (!dbs.primary) {
    return { adapter: "opencode", source: "database", status: "not found", note: "OPENCODE_DB=:memory: keeps no database on disk" };
  }
  const primary = dbs.primary;
  const channels = dbs.existing.filter((path) => path !== primary).map((path) => basename(path));
  return {
    adapter: "opencode",
    source: "database",
    path: primary,
    status: dbs.existing.length ? "ready" : "not found",
    note: channels.length ? `also reading ${channels.join(", ")}` : undefined,
  };
}

function pathRow(adapter: string, source: string, path: string): DoctorRow {
  return { adapter, source, path, status: existsSync(path) ? "ready" : "not found" };
}

export interface StateDirProbe {
  path: string;
  writable: boolean;
  error?: string;
}

/** Every command writes under `~/.agent-peek`; a sandbox that forbids it fails all of them. */
export function probeStateDir(home: string = process.env.HOME ?? homedir()): StateDirProbe {
  const dir = join(home, ".agent-peek");
  const probe = join(dir, `.write-probe-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, "");
    unlinkSync(probe);
    return { path: dir, writable: true };
  } catch (e) {
    return { path: dir, writable: false, error: (e as { code?: string }).code ?? (e as Error).message };
  }
}

/** A command is present if `<cmd> --version` runs, or a login shell can find it. */
export async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], { encoding: "utf8", timeout: 1500 });
    return true;
  } catch {
    try {
      await execFileAsync("sh", ["-lc", `command -v ${shellQuote(command)}`], { encoding: "utf8", timeout: 1500 });
      return true;
    } catch {
      return false;
    }
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
