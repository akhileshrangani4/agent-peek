// src/cli/index.ts
import { cac } from "cac";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createEngine, VERSION } from "../index.js";
import {
  SessionNotFoundError, AmbiguousSelectorError,
  AdapterError, AdapterNotFoundError, RegistryLockTimeoutError,
} from "../core/errors.js";
import type { SessionEntry, SnapshotMode } from "../core/types.js";
import { displayNames } from "../core/names.js";

const execFileAsync = promisify(execFile);
const TERMINAL_ADAPTERS = new Set(["tmux", "screen"]);

export async function run(argv: string[] = process.argv): Promise<number> {
  const cli = cac("peek");
  cli.usage("<command> [options]");
  cli.example("peek list");
  cli.example("peek list --json");
  cli.example("peek at sessionseek-codex --mode structured");
  cli.example("peek ui");
  cli.example("peek doctor");

  cli.command("list [target]", "List local agent sessions. Use `list adapters` for supported adapters.")
    .usage("list [adapters] [--adapter <name>] [--status <status>] [--all] [--terminals] [--ids] [--json]")
    .example("peek list")
    .example("peek list --adapter codex")
    .example("peek list --all --ids")
    .example("peek list --terminals")
    .example("peek list adapters")
    .option("--adapter <name>", "Scan/list only one adapter (claude-code|codex|gemini|tmux|...)")
    .option("--status <s>", "Filter by status (active|idle|ended)")
    .option("--all", "Include ended sessions")
    .option("--terminals", "Include terminal capture adapters (tmux, screen)")
    .option("--ids", "Show raw session ids")
    .option("--json", "Output JSON with id, displayName, sourceType, cwd, and status")
    .action(async (target, opts) => {
      if (target === "adapters") {
        await listAdapters();
        return;
      }
      if (target !== undefined) {
        fail({
          code: 5,
          error: "invalid_list_target",
          message: `Unknown list target: ${target}`,
          hint: "The only supported list target is `adapters`.",
          next: ["peek list", "peek list adapters"],
        });
      }
      const status = parseStatus(opts.status);
      const engine = await createEngine({ withExternal: true });
      let list = await engine.list({
        adapter: opts.adapter,
        status,
        includeTerminal: opts.terminals || isTerminalAdapter(opts.adapter),
      });
      if (!status && !opts.all) {
        list = list.filter((entry) => entry.status !== "ended");
      }
      if (opts.json) { console.log(JSON.stringify(withDisplayNames(list), null, 2)); return; }
      printList(list, { showIds: Boolean(opts.ids) });
    });

  cli.command("at <selector>", "Read a session by displayName, id, tag, or cwd.")
    .usage("at <selector> [--mode raw|structured|summary] [--since <cursor>] [--limit <n>] [--json]")
    .example("peek at sessionseek-codex --mode structured")
    .example("peek at codex:abc123 --mode raw --limit 50")
    .example("peek at buildy-claude --since <nextCursor>")
    .option("--mode <m>", "Snapshot shape: raw transcript, structured status, or summary", { default: "raw" })
    .option("--since <cursor>", "Only return new messages after a prior nextCursor")
    .option("--limit <n>", "Max raw messages to print in raw mode", { default: 200 })
    .option("--json", "Output the full PeekResult JSON")
    .action(async (selector, opts) => {
      const engine = await createEngine({ withExternal: true });
      const r = await engine.peek(selector, {
        mode: parseMode(opts.mode),
        since: opts.since,
        limit: parseLimit(opts.limit),
      });
      if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
      printSnapshot(r);
    });

  cli.command("tag <selector> <asLiteral> <name>", "Assign a stable alias to a session selector.")
    .usage("tag <selector> as <name>")
    .example("peek tag sessionseek-codex as main")
    .example("peek tag codex:abc123 as researcher")
    .action(async (id, asLiteral, name) => {
      if (asLiteral !== "as") {
        fail({
          code: 5,
          error: "invalid_tag_syntax",
          message: "Invalid tag syntax.",
          hint: "Use the literal word `as` between the selector and tag name.",
          next: ["peek tag <selector> as <name>", "peek list --ids"],
        });
      }
      const engine = await createEngine();
      await engine.tag(id, name);
      console.log(`tagged ${id} as ${name}`);
    });

  cli.command("untag <selector>", "Remove a previously assigned session tag.")
    .example("peek untag main")
    .action(async (id) => {
      const engine = await createEngine();
      await engine.untag(id);
      console.log(`untagged ${id}`);
    });

  cli.command("register <id> <atLiteral> <path>", "Manually register a readable session source.")
    .usage("register <adapter:id> at <path> [--as <name>] [--cwd <path>]")
    .example("peek register custom:worker-1 at /tmp/worker.jsonl --as worker")
    .option("--as <name>", "Initial tag/name for the session")
    .option("--cwd <path>", "Working directory to associate with this session")
    .action(async (id, atLiteral, path, opts) => {
      if (atLiteral !== "at") {
        fail({
          code: 5,
          error: "invalid_register_syntax",
          message: "Invalid register syntax.",
          hint: "Use the literal word `at` between the id and path.",
          next: ["peek register <adapter:id> at <path> --as <name>"],
        });
      }
      const colon = id.indexOf(":");
      if (colon <= 0) {
        fail({
          code: 5,
          error: "invalid_session_id",
          message: `Session id must be adapter-prefixed: ${id}`,
          hint: "Use the format <adapter>:<session>, for example `custom:worker-1`.",
          next: ["peek list adapters", "peek register custom:worker-1 at /path/to/transcript.jsonl"],
        });
      }
      const adapter = id.slice(0, colon);
      const engine = await createEngine();
      await engine.register({
        id, adapter, transcriptPath: path,
        tag: opts.as || undefined,
        cwd: opts.cwd || undefined,
      });
      console.log(`registered ${id}`);
    });

  cli.command("forget <id>", "Remove a manually registered or cached registry entry by raw id.")
    .example("peek forget custom:worker-1")
    .action(async (id) => {
      const engine = await createEngine();
      await engine.unregister(id);
      console.log(`forgot ${id}`);
    });

  cli.command("adapters", "Print installed adapter names, one per line.")
    .action(async () => {
      await listAdapters();
    });

  cli.command("ui", "Open an interactive terminal UI for browsing sessions.")
    .usage("ui [--adapter <name>] [--all] [--terminals]")
    .example("peek ui")
    .example("peek ui --adapter codex")
    .example("peek ui --terminals")
    .option("--adapter <name>", "Scan/list only one adapter (claude-code|codex|gemini|tmux|...)")
    .option("--all", "Include ended sessions")
    .option("--terminals", "Include terminal capture adapters (tmux, screen)")
    .action(async (opts) => {
      const { runUi } = await import("./ui.js");
      const code = await runUi({
        adapter: opts.adapter,
        all: Boolean(opts.all),
        terminals: Boolean(opts.terminals),
      });
      if (code !== 0) process.exit(code);
    });

  cli.command("doctor", "Explain adapter availability, missing paths, dependencies, and opt-in terminal capture.")
    .example("peek doctor")
    .example("peek doctor --json")
    .option("--json", "Output machine-readable diagnostic JSON")
    .action(async (opts) => {
      const rows = await doctorRows();
      if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
      printDoctor(rows);
    });

  cli.help();
  cli.version(VERSION);

  try {
    cli.parse(argv, { run: false });
    if (!(cli as unknown as { matchedCommand?: unknown }).matchedCommand && !isGlobalInfoRequest(argv)) {
      fail({
        code: 5,
        error: "unknown_command",
        message: `Unknown or missing command: ${argv.slice(2).join(" ") || "(none)"}`,
        hint: "Run `peek --help` for commands, or use `peek list` to discover sessions.",
        next: ["peek --help", "peek list", "peek doctor"],
      });
    }
    await cli.runMatchedCommand();
    return 0;
  } catch (e) {
    return handleError(e);
  }
}

function isGlobalInfoRequest(argv: string[]): boolean {
  return argv.slice(2).some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v");
}

async function listAdapters(): Promise<void> {
  const engine = await createEngine({ withExternal: true });
  console.log(engine.adapterNames().join("\n"));
}

function handleError(e: unknown): number {
  if (e instanceof SessionNotFoundError) {
    fail({
      code: 2,
      error: "session_not_found",
      message: e.message,
      hint: "Use `peek list` to get the current displayName values. Use `peek list --ids` if you need raw ids.",
      next: ["peek list", "peek list --ids", "peek doctor"],
    });
  }
  if (e instanceof AmbiguousSelectorError) {
    fail({
      code: 3,
      error: "ambiguous_selector",
      message: e.message,
      hint: "Use a more specific selector or copy one raw id from `peek list --ids`.",
      next: ["peek list --ids"],
    });
  }
  if (e instanceof AdapterError || e instanceof AdapterNotFoundError) {
    fail({
      code: 4,
      error: "adapter_error",
      message: (e as Error).message,
      hint: "Check whether the adapter source exists and any required command is installed.",
      next: ["peek doctor", "peek list adapters"],
    });
  }
  if (e instanceof RegistryLockTimeoutError) {
    fail({
      code: 5,
      error: "registry_locked",
      message: e.message,
      hint: "Another peek process is writing the registry. Retry the command.",
      next: ["peek list"],
    });
  }
  const err = e as Error;
  if (err?.name === "CACError") {
    fail({
      code: 5,
      error: "invalid_usage",
      message: err.message,
      hint: "Run command help for the expected arguments and options.",
      next: ["peek --help", "peek list --help", "peek at --help"],
    });
  }
  fail({
    code: 1,
    error: "internal_error",
    message: err?.message ?? String(e),
    hint: "Retry with `--json` only for successful command output; diagnostics are printed on stderr.",
    next: ["peek doctor"],
  });
}

function printList(
  list: { id: string; name?: string; tag?: string; adapter: string; cwd?: string; status: string; lastSeen: string; sourceType?: string; transcriptPath: string }[],
  opts: { showIds?: boolean } = {},
): void {
  if (list.length === 0) { console.log("(no sessions)"); return; }
  const rows = withDisplayNames(list).map((e) => {
    const row = [
      e.displayName,
      e.adapter,
      e.status,
      relativeTime(e.lastSeen),
      sourceLabel(e),
      e.cwd ? formatPath(e.cwd) : "-",
    ];
    if (opts.showIds) row.push(e.id);
    return row;
  });
  const headers = ["NAME", "ADAPTER", "STATUS", "UPDATED", "SOURCE", "CWD"];
  if (opts.showIds) headers.push("ID");
  const cols = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((v, i) => v.padEnd(cols[i]!)).join("  ");
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
}

function withDisplayNames<T extends { id: string; name?: string; tag?: string; adapter: string; cwd?: string }>(
  list: T[],
): (T & { displayName: string })[] {
  const names = displayNames(list);
  return list.map((entry, i) => ({ ...entry, displayName: names[i]! }));
}

function parseStatus(value: unknown): SessionEntry["status"] | undefined {
  if (value === undefined) return undefined;
  if (value === "active" || value === "idle" || value === "ended") return value;
  fail({
    code: 5,
    error: "invalid_status",
    message: `Invalid --status: ${String(value)}`,
    hint: "Status must be one of: active, idle, ended.",
    next: ["peek list --status active", "peek list --status idle", "peek list --status ended"],
  });
}

function parseMode(value: unknown): SnapshotMode {
  if (value === undefined || value === "raw") return "raw";
  if (value === "structured" || value === "summary") return value;
  fail({
    code: 5,
    error: "invalid_mode",
    message: `Invalid --mode: ${String(value)}`,
    hint: "Mode must be one of: raw, structured, summary.",
    next: ["peek at <selector> --mode raw", "peek at <selector> --mode structured", "peek at <selector> --mode summary"],
  });
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (Number.isInteger(limit) && limit > 0) return limit;
  fail({
    code: 5,
    error: "invalid_limit",
    message: `Invalid --limit: ${String(value)}`,
    hint: "Limit must be a positive integer.",
    next: ["peek at <selector> --mode raw --limit 50"],
  });
}

function fail(opts: {
  code: number;
  error: string;
  message: string;
  hint?: string;
  next?: string[];
}): never {
  const lines = [
    `error: ${opts.error}`,
    `message: ${opts.message}`,
  ];
  if (opts.hint) lines.push(`hint: ${opts.hint}`);
  if (opts.next?.length) {
    lines.push("next:");
    for (const item of opts.next) lines.push(`  - ${item}`);
  }
  lines.push(`exitCode: ${opts.code}`);
  console.error(lines.join("\n"));
  process.exit(opts.code);
}

interface DoctorRow {
  adapter: string;
  source: string;
  status: "ready" | "not found" | "needs command" | "opt-in";
  path?: string;
  command?: string;
  note?: string;
}

async function doctorRows(): Promise<DoctorRow[]> {
  const home = process.env.HOME ?? homedir();
  const xdgData = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  const gooseDb = process.platform === "win32" && process.env.APPDATA
    ? join(process.env.APPDATA, "Block", "goose", "data", "sessions", "sessions.db")
    : join(home, ".local", "share", "goose", "sessions", "sessions.db");
  const opencodeStorage = join(xdgData, "opencode", "storage");
  const rows: DoctorRow[] = [
    pathRow("claude-code", "file", join(home, ".claude", "projects")),
    pathRow("codex", "file", join(home, ".codex", "sessions")),
    pathRow("copilot-cli", "directory", join(home, ".copilot", "session-state")),
    pathRow("gemini", "file", join(home, ".gemini", "tmp")),
    {
      ...pathRow("goose", "database", gooseDb),
      command: "sqlite3",
      status: existsSync(gooseDb) ? await commandExists("sqlite3") ? "ready" : "needs command" : "not found",
      note: existsSync(gooseDb) ? "sqlite3 required to query Goose sessions" : undefined,
    },
    pathRow("opencode", "directory", opencodeStorage),
    {
      adapter: "tmux",
      source: "terminal",
      command: "tmux",
      status: await commandExists("tmux") ? "opt-in" : "needs command",
      note: "Use `peek list --terminals` or `--adapter tmux`; captures terminal scrollback.",
    },
    {
      adapter: "screen",
      source: "terminal",
      command: "screen",
      status: await commandExists("screen") ? "opt-in" : "needs command",
      note: "Use `peek list --terminals` or `--adapter screen`; captures terminal scrollback.",
    },
  ];
  return rows;
}

function pathRow(adapter: string, source: string, path: string): DoctorRow {
  return {
    adapter,
    source,
    path,
    status: existsSync(path) ? "ready" : "not found",
  };
}

async function commandExists(command: string): Promise<boolean> {
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printDoctor(rows: DoctorRow[]): void {
  const table = rows.map((row) => [
    row.adapter,
    row.source,
    row.status,
    row.path ? formatPath(row.path) : row.command ?? "-",
    row.note ?? "",
  ]);
  const headers = ["ADAPTER", "SOURCE", "STATUS", "TARGET", "NOTE"];
  const cols = headers.map((h, i) => Math.max(h.length, ...table.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((v, i) => v.padEnd(cols[i]!)).join("  ");
  console.log(fmt(headers));
  for (const row of table) console.log(fmt(row));
}

function isTerminalAdapter(adapter: unknown): boolean {
  return typeof adapter === "string" && TERMINAL_ADAPTERS.has(adapter);
}

function sourceLabel(entry: { adapter: string; sourceType?: string; transcriptPath: string }): string {
  if (entry.sourceType) return entry.sourceType;
  if (entry.transcriptPath.startsWith("tmux://") || entry.transcriptPath.startsWith("screen://")) return "terminal";
  if (entry.transcriptPath.endsWith(".db")) return "database";
  if (isTerminalAdapter(entry.adapter)) return "terminal";
  return "file";
}

function formatPath(path: string): string {
  const home = process.env.HOME ?? homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

function printSnapshot(r: import("../core/types.js").PeekResult): void {
  const s = r.snapshot;
  if (s.mode === "raw") {
    for (const m of s.messages) {
      const head = `[${m.role}]${m.timestamp ? " " + m.timestamp : ""}`;
      console.log(head);
      if (m.text) console.log(indent(m.text));
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          console.log(indent(`tool=${tc.name} status=${tc.status ?? "?"}`));
        }
      }
    }
  } else if (s.mode === "structured") {
    console.log(`session: ${s.sessionId}`);
    console.log(`messages: ${s.messageCount}`);
    console.log(`activity: ${s.activity}`);
    if (s.currentTask) console.log(`task: ${s.currentTask}`);
    if (s.lastAssistantMessage) console.log(`last assistant: ${s.lastAssistantMessage}`);
    if (s.pendingToolCalls.length) {
      console.log(`pending tools: ${s.pendingToolCalls.map((t) => t.name).join(", ")}`);
    }
  } else {
    console.log(s.summary);
    if (s.fallback) console.log(`(fallback: structured returned)`);
  }
  console.log(`\nnextCursor: ${r.nextCursor}`);
}

function indent(s: string, n = 2): string {
  const pad = " ".repeat(n);
  return s.split("\n").map((l) => pad + l).join("\n");
}
