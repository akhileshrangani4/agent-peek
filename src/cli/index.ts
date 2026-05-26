// src/cli/index.ts
import { cac } from "cac";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createEngine, VERSION } from "../index.js";
import {
  SessionNotFoundError, AmbiguousSelectorError,
  AdapterError, AdapterNotFoundError, CursorMismatchError, InvalidCursorError, RegistryLockTimeoutError,
} from "../core/errors.js";
import type {
  CoordinationDigest, PeekResult, RawOrder, RawWindowFrom, SessionEntry, SnapshotMode,
} from "../core/types.js";
import { displayNames } from "../core/names.js";

const execFileAsync = promisify(execFile);
const TERMINAL_ADAPTERS = new Set(["tmux", "screen"]);

export async function run(argv: string[] = process.argv): Promise<number> {
  const cli = cac("peek");
  cli.usage("<command> [options]");
  cli.example("peek list");
  cli.example("peek list --json");
  cli.example("peek at sessionseek-codex --mode structured");
  cli.example("peek coord");
  cli.example("peek check src/core/engine.ts");
  cli.example("peek ui");
  cli.example("peek doctor");

  cli.command("list [target]", "List local agent sessions. Use `list adapters` for supported adapters.")
    .usage("list [adapters] [--adapter <name>] [--status <status>] [--all] [--terminals] [--ids] [--files] [--json]")
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
    .option("--files", "Show active/recent file context for coordination")
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
      if (opts.files) {
        const digest = await engine.coordinate({
          adapter: opts.adapter,
          status,
          includeEnded: Boolean(opts.all),
          includeTerminal: opts.terminals || isTerminalAdapter(opts.adapter),
        });
        if (opts.json) { console.log(JSON.stringify(digest.sessions, null, 2)); return; }
        printListWithFiles(digest.sessions, { showIds: Boolean(opts.ids) });
        return;
      }
      if (opts.json) { console.log(JSON.stringify(withDisplayNames(list), null, 2)); return; }
      printList(list, { showIds: Boolean(opts.ids) });
    });

  cli.command("check <file>", "Exit 1 when another active agent is writing a file.")
    .usage("check <file> [--cwd <path>] [--adapter <name>] [--terminals] [--json]")
    .example("peek check src/core/engine.ts")
    .example("peek check src/core/engine.ts --json")
    .option("--cwd <path>", "Working directory that relative file paths resolve from. Defaults to current directory.")
    .option("--adapter <name>", "Scan only one adapter")
    .option("--terminals", "Include terminal capture adapters (tmux, screen)")
    .option("--json", "Output machine-readable check result")
    .action(async (file, opts) => {
      const cwd = resolve(String(opts.cwd ?? process.cwd()));
      const target = resolve(cwd, String(file));
      const engine = await createEngine({ withExternal: true });
      const digest = await engine.coordinate({
        cwd,
        adapter: opts.adapter,
        includeTerminal: Boolean(opts.terminals) || isTerminalAdapter(opts.adapter),
      });
      const conflicts = activeFileConflicts(digest, target);
      const result = {
        ok: conflicts.length === 0,
        file: target,
        conflictCount: conflicts.length,
        conflicts,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (conflicts.length) {
        console.log(`conflict: ${formatPath(target)} is actively written by ${conflicts.length} session${conflicts.length === 1 ? "" : "s"}`);
        for (const conflict of conflicts) {
          console.log(indent(`${conflict.displayName} (${conflict.adapter}, ${conflict.status})${conflict.lastWritingAt ? ` writing ${relativeTime(conflict.lastWritingAt)}` : ""}`));
          if (conflict.currentTask) console.log(indent(`task: ${oneLine(conflict.currentTask)}`, 4));
        }
      } else {
        console.log(`ok: no active writing conflict for ${formatPath(target)}`);
      }
      if (conflicts.length) process.exitCode = 1;
    });

  cli.command("coord [cwd]", "Summarize nearby agent activity and possible overlap.")
    .usage("coord [cwd] [--since <cursor>] [--since-file <path>] [--adapter <name>] [--status <status>] [--writing] [--fields <list>] [--cursor-file <path>] [--all] [--terminals] [--verbose] [--json]")
    .example("peek coord")
    .example("peek coord . --json")
    .example("peek coord . --json --fields currentTask,activeWritingFiles --cursor-file .peek-cursor")
    .example("peek coord /path/to/repo --since <nextCursor>")
    .option("--cwd <path>", "Working directory to summarize. Defaults to cwd argument or the current directory.")
    .option("--adapter <name>", "Scan/list only one adapter")
    .option("--status <s>", "Filter by status (active|idle|ended)")
    .option("--writing", "Only include sessions with recent write intent")
    .option("--fields <list>", "JSON only: comma-separated session fields to include")
    .option("--since <cursor>", "Coordination cursor returned by a prior coord call")
    .option("--since-file <path>", "Read prior cursor from a file if it exists, then write the next cursor back")
    .option("--cursor-file <path>", "Write the full next cursor to a file and omit it from stdout")
    .option("--cursor-stderr", "Write the full next cursor to stderr and omit it from stdout")
    .option("--all", "Include ended sessions")
    .option("--terminals", "Include terminal capture adapters (tmux, screen)")
    .option("--verbose", "Show known file lists in human output")
    .option("--json", "Output JSON coordination digest")
    .action(async (cwdArg, opts) => {
      const cwd = resolve(String(opts.cwd ?? cwdArg ?? process.cwd()));
      const status = parseStatus(opts.status);
      const sinceFile = opts.sinceFile === undefined ? undefined : resolve(String(opts.sinceFile));
      const since = readCoordinationSince({
        since: opts.since,
        sinceFile,
      });
      const engine = await createEngine({ withExternal: true });
      const digest = await engine.coordinate({
        cwd,
        adapter: opts.adapter,
        status,
        since,
        includeEnded: Boolean(opts.all),
        includeTerminal: Boolean(opts.terminals) || isTerminalAdapter(opts.adapter),
        writingOnly: Boolean(opts.writing),
      });
      const cursorLocation = writeCoordinationCursor(digest.nextCursor, {
        cursorFile: sinceFile ?? opts.cursorFile,
        cursorStderr: Boolean(opts.cursorStderr),
      });
      const omitCursor = Boolean(cursorLocation || opts.cursorStderr);
      if (opts.json) {
        console.log(JSON.stringify(projectCoordinationDigest(digest, {
          fields: opts.fields,
          omitCursor,
          cursorLocation,
        }), null, 2));
        return;
      }
      printCoordinationDigest(digest, {
        verbose: Boolean(opts.verbose),
        cursorLocation,
        suppressCursor: omitCursor,
      });
    });

  cli.command("at <selector>", "Read a session by displayName, id, tag, or cwd.")
    .usage("at <selector> [--mode raw|structured|brief|summary|handoff] [--since <cursor>] [--limit <n>] [--json]")
    .example("peek at sessionseek-codex --mode structured")
    .example("peek at codex:abc123 --mode raw --last 50")
    .example("peek at codex:abc123 --mode raw --first 20")
    .example("peek at codex:abc123 --mode raw --around 100 --limit 30")
    .example("peek at buildy-claude --since <nextCursor>")
    .option("--mode <m>", "Snapshot shape: raw transcript, structured status, brief, handoff, or optional summary", { default: "raw" })
    .option("--since <cursor>", "Only return new messages after a prior nextCursor")
    .option("--limit <n>", "Raw window size. Defaults to 200, or 30 with --around")
    .option("--first <n>", "Show the first N raw messages")
    .option("--last <n>", "Show the last N raw messages")
    .option("--around <n>", "Show raw messages around 1-based message number N")
    .option("--offset <n>", "Skip N messages from the selected edge before applying the raw window")
    .option("--reverse", "Print raw messages newest-first")
    .option("--oldest-first", "Print raw messages oldest-first (default)")
    .option("--tools", "Show tool-only raw messages and tool-call status lines")
    .option("--verbose", "Alias for --tools in raw output")
    .option("--json", "Output the full PeekResult JSON")
    .action(async (selector, opts) => {
      const mode = parseMode(opts.mode);
      const rawOpts = parseRawOpts(opts);
      const engine = await createEngine({ withExternal: true });
      const r = await engine.peek(selector, {
        mode,
        since: opts.since,
        limit: rawOpts.limit,
        offset: rawOpts.offset,
        around: rawOpts.around,
        from: rawOpts.from,
        order: rawOpts.order,
      });
      if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
      printSnapshot(r, { showTools: Boolean(opts.tools || opts.verbose) });
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
  if (e instanceof InvalidCursorError || e instanceof CursorMismatchError) {
    fail({
      code: 5,
      error: "invalid_cursor",
      message: e.message,
      hint: "Use the nextCursor returned by the matching prior command.",
      next: ["peek at <selector> --json", "peek coord . --json"],
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

function printListWithFiles(
  sessions: CoordinationDigest["sessions"],
  opts: { showIds?: boolean } = {},
): void {
  if (sessions.length === 0) { console.log("(no sessions)"); return; }
  const rows = sessions.map((session) => {
    const files = session.activeWritingFiles.length
      ? `writing: ${formatCoordinationFiles(session.activeWritingFiles, { verbose: false })}`
      : session.hotFiles.length
        ? `hot: ${formatCoordinationFiles(session.hotFiles, { verbose: false })}`
        : session.recentFiles.length
          ? `recent: ${formatCoordinationFiles(session.recentFiles, { verbose: false })}`
          : "-";
    const row = [
      session.displayName,
      session.adapter,
      session.status,
      formatCoordinationIntent(session.intent),
      relativeTime(session.lastSeen),
      files,
    ];
    if (opts.showIds) row.push(session.id);
    return row;
  });
  const headers = ["NAME", "ADAPTER", "STATUS", "INTENT", "UPDATED", "FILES"];
  if (opts.showIds) headers.push("ID");
  const cols = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((v, i) => v.padEnd(cols[i]!)).join("  ");
  console.log(fmt(headers));
  for (const row of rows) console.log(fmt(row));
}

function activeFileConflicts(
  digest: CoordinationDigest,
  target: string,
): {
  id: string;
  displayName: string;
  adapter: string;
  status: string;
  currentTask?: string;
  lastWritingAt?: string;
}[] {
  return digest.sessions
    .filter((session) => session.activeWritingFiles.includes(target))
    .map((session) => ({
      id: session.id,
      displayName: session.displayName,
      adapter: session.adapter,
      status: session.status,
      currentTask: session.currentTask,
      lastWritingAt: session.writingFileEvents.find((event) => event.file === target && event.active)?.lastWritingAt,
    }));
}

function printCoordinationDigest(
  digest: CoordinationDigest,
  opts: { verbose?: boolean; cursorLocation?: string; suppressCursor?: boolean } = {},
): void {
  const high = digest.overlapHints.filter((hint) => hint.severity === "high").length;
  const medium = digest.overlapHints.filter((hint) => hint.severity === "medium").length;
  const risk = high ? `, ${high} high overlap${high === 1 ? "" : "s"}`
    : medium ? `, ${medium} medium overlap${medium === 1 ? "" : "s"}` : "";
  const snapshotLabel = digest.firstSnapshot
    ? `first snapshot, ${digest.newSessionCount ?? digest.sessionCount} new`
    : `${digest.changedSessionCount} changed`;
  const countLabel = digest.totalSessionCount === digest.shownSessionCount
    ? `${digest.shownSessionCount} sessions`
    : `${digest.shownSessionCount}/${digest.totalSessionCount} sessions shown`;
  console.log(`coordination: ${countLabel}, ${snapshotLabel}${risk}`);
  if (digest.hiddenLowSignalSessionCount) console.log(`hidden low-signal: ${digest.hiddenLowSignalSessionCount} sessions (--all to include)`);
  if (digest.hiddenUnchangedSessionCount) console.log(`hidden unchanged: ${digest.hiddenUnchangedSessionCount} sessions`);
  if (digest.filteredSessionCount) console.log(`filtered: ${digest.filteredSessionCount} sessions`);
  if (digest.cwd) console.log(`cwd: ${formatPath(digest.cwd)}`);
  if (digest.sessions.length === 0) {
    console.log("(no sessions)");
    printCoordinationCursor(digest.nextCursor, opts);
    return;
  }
  if (digest.overlapHints.length) {
    console.log("\noverlap hints:");
    for (const hint of digest.overlapHints.slice(0, opts.verbose ? undefined : 5)) {
      console.log(indent(`${hint.severity.toUpperCase()} ${formatOverlapHint(hint)}`));
    }
    if (!opts.verbose && digest.overlapHints.length > 5) {
      console.log(indent(`... ${digest.overlapHints.length - 5} more; rerun with --verbose`));
    }
  }
  console.log("\nsessions:");
  for (const session of digest.sessions) {
    console.log(`${session.displayName} (${session.adapter}, ${session.status}${session.activity ? `, ${session.activity}` : ""}, ${formatCoordinationIntent(session.intent)})`);
    if (session.currentTask) console.log(indent(`task: ${oneLine(session.currentTask)}`));
    if (opts.verbose && session.changedMessageCount !== undefined) console.log(indent(`new messages: ${session.changedMessageCount}`));
    if (opts.verbose && shouldShowLastAssistant(session)) console.log(indent(`last assistant: ${oneLine(session.lastAssistantMessage!)}`));
    if (session.pendingTools.length) console.log(indent(`pending tools: ${session.pendingTools.join(", ")}`));
    if (session.recentTools.length) console.log(indent(`recent tools: ${session.recentTools.join(", ")}`));
    if (session.activeWritingFiles.length) console.log(indent(`active writing files: ${formatCoordinationFiles(session.activeWritingFiles, opts)}`));
    if (session.recentWritingFiles.length && !sameStringSet(session.recentWritingFiles, session.activeWritingFiles)) {
      console.log(indent(`recent writes: ${formatCoordinationFiles(session.recentWritingFiles, opts)}`));
    }
    if (session.hotFiles.length) console.log(indent(`hot files: ${formatCoordinationFiles(session.hotFiles, opts)}`));
    else if (session.recentFiles.length) console.log(indent(`recent files: ${formatCoordinationFiles(session.recentFiles, opts)}`));
    if (opts.verbose && session.knownFiles.length) console.log(indent(`known files: ${formatCoordinationFiles(session.knownFiles, opts)}`));
    if (session.error) console.log(indent(`error: ${session.error}`));
  }
  printCoordinationCursor(digest.nextCursor, opts);
}

function formatCoordinationIntent(intent: CoordinationDigest["sessions"][number]["intent"]): string {
  if (intent === "writing") return "recent-writing";
  if (intent === "reading") return "recent-reading";
  return "intent-unknown";
}

function shouldShowLastAssistant(session: CoordinationDigest["sessions"][number]): boolean {
  if (!session.lastAssistantMessage) return false;
  if (!session.currentTask) return true;
  const task = oneLine(session.currentTask, 240).toLowerCase();
  const last = oneLine(session.lastAssistantMessage, 240).toLowerCase();
  return !task || !last.includes(task) && !task.includes(last);
}

function formatOverlapHint(hint: CoordinationDigest["overlapHints"][number]): string {
  let message = hint.message;
  if (hint.file) message = message.replaceAll(hint.file, formatPath(hint.file));
  if (hint.cwd) message = message.replaceAll(hint.cwd, formatPath(hint.cwd));
  if (hint.lastWritingAt) return `${message} Last writer ${relativeTime(hint.lastWritingAt)}.`;
  if (hint.lastActivityAt) return `${message} Last activity ${relativeTime(hint.lastActivityAt)}.`;
  return message;
}

function formatCoordinationFiles(files: string[], opts: { verbose?: boolean }): string {
  const max = opts.verbose ? files.length : 5;
  const visible = files.slice(0, max).map(formatPath).join(", ");
  const remaining = files.length - max;
  return remaining > 0 ? `${visible}, ... ${remaining} more` : visible;
}

function printCoordinationCursor(
  cursor: string,
  opts: { cursorLocation?: string; suppressCursor?: boolean } = {},
): void {
  if (opts.cursorLocation) {
    console.log(`\nnextCursor: written to ${formatPath(opts.cursorLocation)}`);
    return;
  }
  if (opts.suppressCursor) return;
  printNextCursor(cursor);
}

function printNextCursor(cursor: string): void {
  if (cursor.length <= 1200) {
    console.log(`\nnextCursor: ${cursor}`);
    return;
  }
  console.log(`\nnextCursor: ${cursor.slice(0, 80)}... (${cursor.length} chars; use --since-file .peek-cursor or --cursor-file .peek-cursor for polling)`);
}

function readCoordinationSince(opts: { since?: unknown; sinceFile?: string }): string | undefined {
  if (opts.since !== undefined && opts.sinceFile) {
    fail({
      code: 5,
      error: "invalid_usage",
      message: "Cannot combine --since and --since-file.",
      hint: "Use --since for an inline cursor or --since-file for a polling cursor file.",
      next: ["peek coord . --since-file .peek-cursor --json"],
    });
  }
  if (opts.since !== undefined) return String(opts.since);
  if (!opts.sinceFile || !existsSync(opts.sinceFile)) return undefined;
  const cursor = readFileSync(opts.sinceFile, "utf8").trim();
  return cursor || undefined;
}

function writeCoordinationCursor(
  cursor: string,
  opts: { cursorFile?: unknown; cursorStderr?: boolean },
): string | undefined {
  let cursorLocation: string | undefined;
  if (opts.cursorFile !== undefined) {
    cursorLocation = resolve(String(opts.cursorFile));
    writeFileSync(cursorLocation, `${cursor}\n`, "utf8");
  }
  if (opts.cursorStderr) {
    console.error(`nextCursor: ${cursor}`);
  }
  return cursorLocation;
}

function projectCoordinationDigest(
  digest: CoordinationDigest,
  opts: { fields?: unknown; omitCursor?: boolean; cursorLocation?: string },
): Record<string, unknown> {
  const projected: Record<string, unknown> = { ...digest };
  if (opts.fields !== undefined) {
    const fields = parseCoordinationFields(opts.fields);
    projected.sessions = digest.sessions.map((session) => projectCoordinationSession(session, fields));
  }
  if (opts.omitCursor) delete projected.nextCursor;
  if (opts.cursorLocation) projected.cursorFile = opts.cursorLocation;
  return projected;
}

const COORDINATION_IDENTITY_FIELDS = ["id", "displayName", "adapter", "status", "lastSeen"] as const;
const COORDINATION_SESSION_FIELDS = new Set([
  ...COORDINATION_IDENTITY_FIELDS,
  "activity",
  "cwd",
  "sourceType",
  "messageCount",
  "changedMessageCount",
  "currentTask",
  "lastAssistantMessage",
  "pendingTools",
  "recentTools",
  "intent",
  "recentFiles",
  "knownFiles",
  "hotFiles",
  "activeWritingFiles",
  "recentWritingFiles",
  "writingFileEvents",
  "writingFiles",
  "writingFilesLastSeen",
  "touchedFiles",
  "error",
]);

function parseCoordinationFields(value: unknown): string[] {
  const fields = String(value)
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  const invalid = fields.filter((field) => !COORDINATION_SESSION_FIELDS.has(field));
  if (fields.length === 0 || invalid.length) {
    fail({
      code: 5,
      error: "invalid_fields",
      message: invalid.length
        ? `Unknown coordination field(s): ${invalid.join(", ")}`
        : "At least one coordination field is required.",
      hint: `Use comma-separated session fields such as: currentTask,intent,activeWritingFiles,pendingTools.`,
      next: ["peek coord . --json --fields currentTask,intent,activeWritingFiles,pendingTools"],
    });
  }
  return [...new Set([...COORDINATION_IDENTITY_FIELDS, ...fields])];
}

function projectCoordinationSession(
  session: CoordinationDigest["sessions"][number],
  fields: string[],
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  const record = session as unknown as Record<string, unknown>;
  for (const field of fields) {
    if (record[field] !== undefined) projected[field] = record[field];
  }
  return projected;
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((item) => bSet.has(item));
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
  if (value === "structured" || value === "brief" || value === "summary" || value === "handoff") return value;
  fail({
    code: 5,
    error: "invalid_mode",
    message: `Invalid --mode: ${String(value)}`,
    hint: "Mode must be one of: raw, structured, brief, summary, handoff.",
    next: ["peek at <selector> --mode raw", "peek at <selector> --mode structured", "peek at <selector> --mode brief", "peek at <selector> --mode summary", "peek at <selector> --mode handoff"],
  });
}

interface RawCliOpts {
  limit: number;
  offset?: number;
  around?: number;
  from: RawWindowFrom;
  order: RawOrder;
}

function parseRawOpts(opts: {
  limit?: unknown;
  first?: unknown;
  last?: unknown;
  around?: unknown;
  offset?: unknown;
  reverse?: unknown;
  oldestFirst?: unknown;
}): RawCliOpts {
  if (opts.reverse && opts.oldestFirst) {
    fail({
      code: 5,
      error: "invalid_raw_order",
      message: "Cannot combine --reverse and --oldest-first.",
      hint: "Use one raw ordering flag.",
      next: ["peek at <selector> --reverse", "peek at <selector> --oldest-first"],
    });
  }

  const hasFirst = opts.first !== undefined;
  const hasLast = opts.last !== undefined;
  const hasAround = opts.around !== undefined;
  if ([hasFirst, hasLast, hasAround].filter(Boolean).length > 1) {
    fail({
      code: 5,
      error: "invalid_raw_window",
      message: "Choose only one of --first, --last, or --around.",
      hint: "--limit can be used by itself, or with --around to set the window size.",
      next: ["peek at <selector> --first 20", "peek at <selector> --last 50", "peek at <selector> --around 100 --limit 30"],
    });
  }
  if (hasAround && opts.offset !== undefined) {
    fail({
      code: 5,
      error: "invalid_raw_window",
      message: "Cannot combine --around and --offset.",
      hint: "--around already selects the center of the raw window.",
      next: ["peek at <selector> --around 100 --limit 30"],
    });
  }

  const order: RawOrder = opts.reverse ? "newest-first" : "oldest-first";
  const offset = parseOffset(opts.offset);
  if (hasFirst) {
    return { limit: parseRequiredPositive(opts.first, "--first"), offset, from: "start", order };
  }
  if (hasLast) {
    return { limit: parseRequiredPositive(opts.last, "--last"), offset, from: "end", order };
  }
  if (hasAround) {
    return {
      limit: opts.limit === undefined ? 30 : parseRequiredPositive(opts.limit, "--limit"),
      around: parseRequiredPositive(opts.around, "--around"),
      from: "start",
      order,
    };
  }
  return {
    limit: opts.limit === undefined ? 200 : parseRequiredPositive(opts.limit, "--limit"),
    offset,
    from: "end",
    order,
  };
}

function parseRequiredPositive(value: unknown, flag: string): number {
  const limit = Number(value);
  if (Number.isInteger(limit) && limit > 0) return limit;
  fail({
    code: 5,
    error: "invalid_limit",
    message: `Invalid ${flag}: ${String(value)}`,
    hint: `${flag} must be a positive integer.`,
    next: [`peek at <selector> ${flag} 50`],
  });
}

function parseOffset(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const offset = Number(value);
  if (Number.isInteger(offset) && offset >= 0) return offset;
  fail({
    code: 5,
    error: "invalid_offset",
    message: `Invalid --offset: ${String(value)}`,
    hint: "Offset must be a non-negative integer.",
    next: ["peek at <selector> --last 50 --offset 50"],
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

function printSnapshot(r: PeekResult, opts: { showTools?: boolean } = {}): void {
  const s = r.snapshot;
  if (s.mode === "raw") {
    console.log(`messages: ${s.window.start + 1}-${s.window.end} of ${s.totalMessageCount} (${s.window.order})`);
    for (const m of s.messages) {
      if (!opts.showTools && !m.text) continue;
      const head = `[${m.role}]${m.timestamp ? " " + m.timestamp : ""}`;
      console.log(head);
      if (m.text) console.log(indent(m.text));
      if (opts.showTools && m.toolCalls?.length) {
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
    if (s.writingFiles.length) console.log(`writing files: ${s.writingFiles.map(formatPath).join(", ")}`);
    if (s.touchedFiles.length) console.log(`touched files: ${s.touchedFiles.map(formatPath).join(", ")}`);
    if (s.pendingToolCalls.length) {
      console.log(`pending tools: ${s.pendingToolCalls.map((t) => t.name).join(", ")}`);
    }
  } else if (s.mode === "brief") {
    console.log(s.brief);
    console.log(`activity: ${s.activity}`);
    console.log(`messages: ${s.messageCount}`);
    if (s.pendingTools.length) console.log(`pending tools: ${s.pendingTools.join(", ")}`);
    if (s.recentTools.length) console.log(`recent tools: ${s.recentTools.join(", ")}`);
  } else if (s.mode === "handoff") {
    console.log(`session: ${s.sessionId}`);
    console.log(`messages: ${s.messageCount}`);
    console.log(`activity: ${s.activity}`);
    if (s.currentTask) console.log(`task: ${oneLine(s.currentTask)}`);
    printListSection("decisions", s.decisions);
    printListSection("open questions", s.openQuestions);
    printListSection("next actions", s.nextActions);
    printListSection("files", s.touchedFiles.map(formatPath));
    if (s.pendingTools.length) console.log(`pending tools: ${s.pendingTools.join(", ")}`);
    if (s.recentTools.length) console.log(`recent tools: ${s.recentTools.join(", ")}`);
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

function printListSection(label: string, values: string[]): void {
  if (!values.length) return;
  console.log(`${label}:`);
  for (const value of values) console.log(indent(`- ${value}`));
}

function oneLine(value: string, max = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}...` : flat;
}
