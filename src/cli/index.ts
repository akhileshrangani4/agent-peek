// src/cli/index.ts
import { cac } from "cac";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createEngine, VERSION } from "../index.js";
import { ClaimsStore } from "../core/claims.js";
import {
  SessionNotFoundError, AmbiguousSelectorError,
  AdapterError, AdapterNotFoundError, CursorMismatchError, InvalidCursorError, RegistryLockTimeoutError,
  PostRejectedError, PostNotFoundError, NotAProjectError,
} from "../core/errors.js";
import type {
  CoordinationDigest, PeekResult, RawOrder, RawWindowFrom, SessionEntry, SnapshotMode,
} from "../core/types.js";
import { displayNames } from "../core/names.js";
import {
  addAgent, isPresent, listAgents, removeAgent, sharedLibraryRoot, AGENT_TABLE_SOURCE,
} from "../agents/index.js";
import type { SkillRoot } from "../agents/index.js";
import {
  buildInventory, buildNameIndex, builtinRowFilter, discoverProjects,
  buildSkillsReport, expandSkill, joinUsage, usageSeries,
  planArchive, executeArchive, executeRestore, readArchiveLog, findArchive,
  manifestDivergence, ArchiveRefusedError,
} from "../skills/index.js";
import type { ArchivePlan, InstallationRow } from "../skills/index.js";
import { renderSkillsReport, renderSkillsSegment } from "./skills-report.js";
import { renderUsageReport } from "./usage-report.js";
import { renderAgents } from "./agents-report.js";
import { renderList } from "./list-report.js";
import { renderDoctor } from "./doctor-report.js";
import type { Inventory } from "../skills/types.js";
import { UsageStore, usageDbPath, scanAll, GROUP_BY_DIMENSIONS, usageSeriesFor } from "../usage/index.js";
import { buildUsageReport } from "../usage/report.js";
import type { GroupBy, UsageRow } from "../usage/index.js";
import type { PostType } from "../feed/schema.js";
import { resolveAuthor } from "../feed/identity.js";

const execFileAsync = promisify(execFile);
const TERMINAL_ADAPTERS = new Set(["tmux", "screen"]);

export async function run(argv: string[] = process.argv): Promise<number> {
  const cli = cac("peek");
  cli.usage("<command> [options]");
  cli.example("peek list");
  cli.example("peek list --json");
  cli.example("peek at ledgerforge-codex --mode structured");
  cli.example("peek coord");
  cli.example("peek check src/core/engine.ts");
  cli.example("peek claim src/core/engine.ts --ttl 2m");
  cli.example("peek version");
  cli.example("peek update");
  cli.example("peek ui");
  cli.example("peek doctor");

  cli.command("help [command]", "Show focused help for humans and agents.")
    .usage("help [command]")
    .example("peek help")
    .example("peek help coord")
    .action((command) => {
      printFocusedHelp(command === undefined ? undefined : String(command));
    });

  cli.command("version", "Print the installed agent-peek version.")
    .usage("version [--json]")
    .example("peek version")
    .example("peek version --json")
    .option("--json", "Output machine-readable version info")
    .action((opts) => {
      const result = { name: "agent-peek", version: VERSION };
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else console.log(`agent-peek ${VERSION}`);
    });

  cli.command("update", "Update the global agent-peek install from npm.")
    .usage("update [--check] [--force] [--json]")
    .example("peek update")
    .example("peek update --check")
    .example("peek update --json")
    .option("--check", "Only check the latest npm version; do not install")
    .option("--force", "Run the install command even when the latest version matches")
    .option("--json", "Output machine-readable update info")
    .action(async (opts) => {
      const result = await updateInfo();
      if (opts.check) {
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else printUpdateInfo(result);
        return;
      }
      const update = await performUpdate(result, { force: Boolean(opts.force) });
      if (opts.json) {
        console.log(JSON.stringify(update, null, 2));
        return;
      }
      printUpdateResult(update);
    });

  cli.command("list [target]", "List local agent sessions. Use `list adapters` for supported adapters.")
    .usage("list [adapters] [--adapter <name>] [--status <status>] [--all] [--terminals] [--include-subagents] [--ids] [--files] [--json]")
    .example("peek list")
    .example("peek list --adapter codex")
    .example("peek list --all --ids")
    .example("peek list --terminals")
    .example("peek list --include-subagents")
    .example("peek list adapters")
    .option("--adapter <name>", "Scan/list only one adapter (claude-code|codex|gemini|tmux|...)")
    .option("--status <s>", "Filter by status (active|idle|ended)")
    .option("--all", "Include ended sessions")
    .option("--color", "Force colour even when piped")
    .option("--width <n>", "Render at this width instead of the terminal width")
    .option("--terminals", "Include terminal capture adapters (tmux, screen)")
    .option("--include-subagents", "Include subagent sessions spawned by another session")
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
      // Discovery is truthful, the view is opinionated: subagents are found, tracked,
      // and fed to coordination and the usage index, but they would roughly triple a
      // machine's session list, so the default view hides them.
      if (!opts.includeSubagents) {
        list = list.filter((entry) => entry.parentSessionId === undefined);
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
      await renderList(withDisplayNames(list), {
        showIds: Boolean(opts.ids),
        color: Boolean(opts.color),
        width: opts.width === undefined ? undefined : Number(opts.width),
        relativeTime,
      });
    });

  cli.command("check [file]", "Exit 1 when another active agent is writing a file.")
    .usage("check [file] [--files-from <path|->] [--cwd <path>] [--adapter <name>] [--terminals] [--json]")
    .example("peek check src/core/engine.ts")
    .example("peek check --files-from changed-files.txt")
    .example("peek check src/core/engine.ts --json")
    .option("--files-from <path>", "Read files to check from a newline-delimited file, or '-' for stdin")
    .option("--cwd <path>", "Working directory that relative file paths resolve from. Defaults to current directory.")
    .option("--adapter <name>", "Scan only one adapter")
    .option("--as <owner>", "Ignore active claims owned by this agent")
    .option("--ignore-self", "Ignore active claims owned by the default local owner")
    .option("--terminals", "Include terminal capture adapters (tmux, screen)")
    .option("--json", "Output machine-readable check result")
    .action(async (file, opts) => {
      const cwd = resolve(String(opts.cwd ?? process.cwd()));
      const targets = checkTargets(file, opts.filesFrom, cwd);
      const ignoredOwner = opts.as ? String(opts.as) : opts.ignoreSelf ? await defaultClaimOwner() : undefined;
      const engine = await createEngine({ withExternal: true });
      const digest = await engine.coordinate({
        cwd,
        adapter: opts.adapter,
        includeTerminal: Boolean(opts.terminals) || isTerminalAdapter(opts.adapter),
      });
      const files = targets.map((target) => ({
        file: target,
        conflicts: activeFileConflicts(digest, target, ignoredOwner),
      }));
      const conflictCount = files.reduce((count, item) => count + item.conflicts.length, 0);
      const result = {
        ok: conflictCount === 0,
        files,
        conflictCount,
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (conflictCount) {
        console.log(`conflict: ${conflictCount} active file conflict${conflictCount === 1 ? "" : "s"}`);
        for (const item of files) {
          for (const conflict of item.conflicts) {
            console.log(indent(`${formatPath(item.file)} claimed/written by ${conflict.displayName} (${conflict.adapter}, ${conflict.status})${conflict.lastWritingAt ? ` ${relativeTime(conflict.lastWritingAt)}` : ""}`));
            if (conflict.currentTask) console.log(indent(`task: ${oneLine(conflict.currentTask)}`, 4));
          }
        }
      } else {
        console.log(`ok: no active writing conflict for ${targets.map(formatPath).join(", ")}`);
      }
      if (conflictCount) process.exitCode = 1;
    });

  cli.command("claim <file>", "Declare intent to write files so other agents can avoid conflicts.")
    .usage("claim <file> [--files-from <path|->] [--ttl <duration>] [--cwd <path>] [--as <owner>] [--json]")
    .example("peek claim src/core/engine.ts --ttl 2m")
    .example("peek claim src/core/engine.ts --files-from changed-files.txt --as codex-main")
    .option("--files-from <path>", "Also read files to claim from a newline-delimited file, or '-' for stdin")
    .option("--ttl <duration>", "Claim TTL such as 30s, 2m, or 1h", { default: "2m" })
    .option("--cwd <path>", "Working directory that relative file paths resolve from. Defaults to current directory.")
    .option("--as <owner>", "Owner name shown to other agents")
    .option("--json", "Output machine-readable claim")
    .action(async (file, opts) => {
      const cwd = resolve(String(opts.cwd ?? process.cwd()));
      const targets = checkTargets(file, opts.filesFrom, cwd);
      const claims = new ClaimsStore();
      const claim = await claims.claim({
        files: targets,
        cwd,
        owner: opts.as ? String(opts.as) : await defaultClaimOwner(),
        ttlMs: parseDurationMs(opts.ttl, "--ttl"),
      });
      if (opts.json) {
        console.log(JSON.stringify(claim, null, 2));
        return;
      }
      console.log(`claimed ${claim.files.length} file${claim.files.length === 1 ? "" : "s"} until ${claim.expiresAt}`);
      console.log(indent(`id: ${claim.id}`));
      for (const claimedFile of claim.files) console.log(indent(formatPath(claimedFile)));
    });

  cli.command("release <claimOrFile>", "Release a file claim by claim id or file path.")
    .usage("release <claim-id|file> [--claim-id] [--files-from <path|->] [--cwd <path>] [--json]")
    .example("peek release src/core/engine.ts")
    .example("peek release <claim-id> --claim-id --json")
    .option("--claim-id", "Treat the argument as a claim id")
    .option("--files-from <path>", "With --claim-id, release only these newline-delimited files from the claim")
    .option("--cwd <path>", "Working directory that relative file paths resolve from. Defaults to current directory.")
    .option("--json", "Output machine-readable release result")
    .action(async (claimOrFile, opts) => {
      const cwd = resolve(String(opts.cwd ?? process.cwd()));
      const rawSelector = String(claimOrFile);
      const selector = opts.claimId || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(rawSelector)
        ? rawSelector
        : resolve(cwd, rawSelector);
      const partialFiles = opts.filesFrom === undefined ? undefined : readFilesFrom(String(opts.filesFrom)).map((file) => resolve(cwd, file));
      const releasedClaims = await new ClaimsStore().release(selector, { files: partialFiles });
      const result = {
        released: releasedClaims.length,
        claims: releasedClaims,
        files: [...new Set(releasedClaims.flatMap((claim) => claim.files))].sort(),
      };
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`released ${result.released} claim${result.released === 1 ? "" : "s"}`);
      for (const claim of releasedClaims) {
        console.log(indent(`${claim.id} (${claim.owner}) ${claim.files.length} file${claim.files.length === 1 ? "" : "s"}`));
      }
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
        suppressCursor: omitCursor || !opts.verbose,
      });
    });

  cli.command("at <selector>", "Read a session by displayName, id, tag, or cwd.")
    .usage("at <selector> [--mode raw|structured|brief|summary|handoff] [--since <cursor>] [--limit <n>] [--json]")
    .example("peek at ledgerforge-codex --mode structured")
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

  cli.command("agents [action] [slug]", "List coding agents peek knows, their skill roots, and what it can observe.")
    .usage("agents [add|remove <slug>] [--skills <path>] [--adapter <name>] [--name <display>] [--all] [--json]")
    .example("peek agents")
    .example("peek agents --json")
    .example("peek agents add amp --skills ~/.amp/skills")
    .example("peek agents remove amp")
    .option("--skills <path>", "Skill root for `add` (repeatable via comma-separated list)")
    .option("--adapter <name>", "Transcript adapter this agent uses, when peek has one")
    .option("--name <display>", "Display name for `add`")
    .option("--color", "Force colour even when piped")
    .option("--width <n>", "Render at this width instead of the terminal width")
    .option("--all", "Include agents with no skill root on this machine")
    .option("--json", "Output machine-readable JSON")
    .action(async (action, slug, opts) => {
      if (action === undefined || action === "list") {
        await printAgentsCommand({ all: Boolean(opts.all), json: Boolean(opts.json) });
        return;
      }
      if (action === "add") {
        if (!slug) {
          fail({
            code: 5,
            error: "missing_slug",
            message: "`peek agents add` needs an agent slug.",
            hint: "Use the product slug, e.g. `peek agents add amp --skills ~/.amp/skills`.",
            next: ["peek agents", "peek agents add <slug> --skills <path>"],
          });
        }
        const paths = String(opts.skills ?? "").split(",").map((p: string) => p.trim()).filter(Boolean);
        if (paths.length === 0) {
          fail({
            code: 5,
            error: "missing_skill_root",
            message: "`peek agents add` needs at least one --skills path.",
            hint: "An agent with no skill root and no adapter is invisible to peek.",
            next: ["peek agents add <slug> --skills <path>"],
          });
        }
        const roots: SkillRoot[] = paths.map((path: string) => ({
          path: resolve(expandHome(path)),
          kind: "user" as const,
          mutable: true,
        }));
        await addAgent({
          slug,
          displayName: opts.name ?? slug,
          adapter: opts.adapter,
          roots,
        });
        console.log(`registered agent ${slug}`);
        return;
      }
      if (action === "remove") {
        if (!slug) {
          fail({
            code: 5,
            error: "missing_slug",
            message: "`peek agents remove` needs an agent slug.",
            hint: "Run `peek agents --all` to see registered slugs.",
            next: ["peek agents --all"],
          });
        }
        const removed = await removeAgent(slug);
        console.log(removed
          ? `removed agent entry ${slug}`
          : `no user entry for ${slug} (builtin agents cannot be removed)`);
        return;
      }
      fail({
        code: 5,
        error: "invalid_agents_action",
        message: `Unknown agents action: ${action}`,
        hint: "Supported actions are `add` and `remove`; omit the action to list.",
        next: ["peek agents", "peek agents add <slug> --skills <path>", "peek agents remove <slug>"],
      });
    });

  cli.command("usage [dimension]", "Aggregate tool and skill invocations across every agent, from a durable index.")
    .usage("usage [skill|tool|agent|adapter|day|cwd|sourceKind|sidechain|attributionAgent] [--tool <name>] [--since <30d|ISO>] [--json]")
    .example("peek usage")
    .example("peek usage --since 7d")
    .example("peek usage tool --all-tools")
    .example("peek usage attributionAgent --sidechain")
    .example("peek usage day --skill wayfinder")
    .option("--tool <name>", "Only invocations of this tool (default: Skill)")
    .option("--all-tools", "Every tool, not just skills")
    .option("--include-builtins", "Keep CLI built-ins like /clear, which are recorded but are not skills")
    .option("--skill <name>", "Only this skill or command name")
    .option("--agent <slug>", "Only this agent")
    .option("--adapter <name>", "Only this adapter")
    .option("--cwd <path>", "Only invocations recorded in this directory")
    .option("--since <when>", "Duration (30d, 24h) or ISO date")
    .option("--until <when>", "Duration or ISO date, exclusive")
    .option("--sidechain", "Only invocations made inside a subagent")
    .option("--main-loop", "Only invocations made outside a subagent")
    .option("--attribution-agent <type>", "Only invocations by this subagent type")
    .option("--by <dims>", "Comma-separated grouping dimensions (default: skill)")
    .option("--limit <n>", "Maximum rows (default: 20)")
    .option("--no-scan", "Report from the index without scanning for new transcripts first")
    .option("--verbose", "List every agent whose usage cannot be attributed, instead of a count")
    .option("--width <n>", "Render at this width instead of the detected terminal width")
    .option("--color", "Force colour even when output is piped")
    .option("--json", "Output the full report envelope as JSON")
    .action(async (dimension, opts) => {
      await runUsage(dimension, opts);
    });

  cli.command("skills [action] [selector]", "Inventory skills across every agent root, and archive or restore one.")
    .usage("skills [archive|restore|archives] [<name>] [--interactive] [--skill <name>] [--agent <slug>] [--all-agents] [--yes] [--json] [--projects <dir,dir>]")
    .example("peek skills")
    .example("peek skills --interactive")
    .example("peek skills --json")
    .example("peek skills archive my-skill --agent codex")
    .example("peek skills archive my-skill --all-agents --yes")
    .example("peek skills restore my-skill --yes")
    .example("peek skills archives")
    .option("--json", "Output JSON")
    .option("--projects <dirs>", "Comma-separated project directories to scan for project-local roots")
    .option("--limit <n>", "Rows per segment (default: 20 archivable, 8 elsewhere)")
    .option("--agent <slug>", "Limit an archive to one agent's installation")
    .option("--all-agents", "Retire the skill from every mutable root it is installed in")
    .option("--yes", "Execute. Without it, archive and restore only describe what they would do.")
    .option("--skill <name>", "Show every installation of one skill and what archiving each would do")
    .option("--interactive", "Browse and mark skills to archive in a terminal picker")
    .option("--width <n>", "Render at this width instead of the detected terminal width")
    .option("--color", "Force colour even when output is piped")
    .option("--segment <id>", "Show every row of one segment (archivable|unknown-usage|read-only|in-use)")
    .action(async (action, selector, opts) => {
      if (action === "archive" || action === "restore" || action === "archives") {
        await skillsMutationCommand(action, selector, opts);
        return;
      }
      if (action !== undefined) {
        fail({
          code: 5,
          error: "invalid_skills_action",
          message: `Unknown skills action: ${action}`,
          hint: "Supported actions are `archive`, `restore`, and `archives`; omit the action to inventory.",
          next: ["peek skills --json", "peek skills archive <name> --agent <slug>", "peek skills archives"],
        });
      }
      if (opts.interactive) {
        const projects = String(opts.projects ?? "").split(",").map((p: string) => p.trim())
          .filter(Boolean).map((p: string) => resolve(expandHome(p)));
        const { runSkillsUi } = await import("./skills-ui.js");
        process.exitCode = await runSkillsUi({ projects });
        return;
      }
      if (!opts.json) {
        await runSkillsReport(opts);
        return;
      }
      const { projects, discovery } = await resolveProjectSurvey(opts.projects);
      const inventory = await buildInventory({ projects, projectDiscovery: discovery });
      console.log(JSON.stringify(await skillsJson(inventory), null, 2));
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

  cli.command("post <type> <title>", "Publish a context post to this project's feed.")
    .usage("post <type> <title> --text <body> [--paths a,b] [--topics t1,t2] [--evidence file:src/a.ts:41,commit:abc] [--reply-to <id>] [--supersedes <id>] [--mention <selector>] [--ttl <duration>] [--as <selector>] [--dir <path>] [--json]")
    .example('peek post finding "Auth lives in middleware" --text "verify.ts owns it" --paths src/verify.ts')
    .option("--text <body>", "Post body (<= 150 tokens). Required.")
    .option("--paths <list>", "Comma-separated repo-relative paths (required for finding/warning)")
    .option("--topics <list>", "Comma-separated free-form topics")
    .option("--evidence <list>", "Comma-separated refs: file:<path>[:line] | commit:<sha> | session:<id>")
    .option("--reply-to <id>", "Post id this answers")
    .option("--supersedes <id>", "Post id this replaces")
    .option("--mention <selector>", "Session/tag to notify (repeatable)")
    .option("--ttl <duration>", "Override lifetime, e.g. 30m, 4h, 7d")
    .option("--as <selector>", "Author identity override")
    .option("--dir <path>", "Project directory. Defaults to cwd.")
    .option("--json", "Output the stored post as JSON")
    .action(async (type, title, opts) => {
      const { postToFeed } = await import("../feed/index.js");
      const dir = resolve(String(opts.dir ?? process.cwd()));
      if (opts.text === undefined) {
        throw new PostRejectedError("--text is required. Provide the post body (<= 150 tokens).");
      }
      // A bare `--text` flag (no value) or a repeated `--text` flag is
      // parsed by the CLI as boolean `true` or an array, not a string.
      // Reject it here instead of letting String() coerce it into the
      // literal text "true" (or "true,<other value>").
      if (typeof opts.text !== "string") {
        throw new PostRejectedError("--text requires a single string value. Provide the post body (<= 150 tokens).");
      }
      const engine = await createEngine({ withExternal: true });
      const post = await postToFeed({
        dir,
        engine,
        as: opts.as ? String(opts.as) : undefined,
        input: {
          type: String(type) as PostType,
          title: String(title),
          text: String(opts.text),
          paths: splitList(opts.paths),
          topics: splitList(opts.topics),
          evidence: parseEvidence(opts.evidence),
          replyTo: opts.replyTo ? String(opts.replyTo) : undefined,
          supersedes: opts.supersedes ? String(opts.supersedes) : undefined,
          mentions: splitList(opts.mention),
          ttlMs: opts.ttl ? parseDurationMs(opts.ttl, "--ttl") : undefined,
        },
      });
      if (opts.json) { console.log(JSON.stringify(post, null, 2)); return; }
      console.log(`posted ${post.type} ${post.id} (expires ${relativeTime(post.lifecycle.expiresAt)})`);
    });

  cli.command("feed [dir]", "Read this project's context feed, ranked and packed to a token budget.")
    .usage("feed [dir] [--budget <n>] [--context-paths a,b] [--since <cursor>] [--cursor-file <path>] [--type t1,t2] [--reader <selector>] [--no-derived] [--stats] [--json]")
    .example("peek feed")
    .example("peek feed . --budget 500 --json")
    .option("--budget <n>", "Token budget for the packed feed", { default: 600 })
    .option("--context-paths <list>", "Comma-separated paths the reader is working on (improves ranking)")
    .option("--since <cursor>", "Only content newer than this cursor")
    .option("--cursor-file <path>", "Read the cursor from this file and write nextCursor back to it")
    .option("--type <list>", "Comma-separated post types to include")
    .option("--reader <selector>", "Reader identity (boosts mentions; logged in stats)")
    .option("--no-derived", "Skip derived posts (status, overlap warnings)")
    .option("--stats", "Print feed usage stats instead of the feed")
    .option("--json", "Machine-readable output")
    .action(async (dirArg, opts) => {
      const { readFeed, feedStats } = await import("../feed/index.js");
      const dir = resolve(String(dirArg ?? process.cwd()));
      if (opts.stats) {
        const stats = await feedStats({ dir });
        if (opts.json) { console.log(JSON.stringify(stats, null, 2)); return; }
        console.log(`project: ${stats.projectLabel}`);
        console.log(indent(`posts: ${stats.posts} (${Object.entries(stats.byType).map(([t, n]) => `${t} ${n}`).join(", ") || "none"})`));
        console.log(indent(`feeds served: ${stats.feedsServed}, tokens delivered: ${stats.tokensServed}`));
        return;
      }
      const since = opts.cursorFile && existsSync(String(opts.cursorFile))
        ? readFileSync(String(opts.cursorFile), "utf8").trim() || undefined
        : opts.since ? String(opts.since) : undefined;
      const engine = await createEngine({ withExternal: true });
      const result = await readFeed({
        dir,
        engine,
        budget: Number(opts.budget),
        contextPaths: splitList(opts.contextPaths),
        since,
        types: opts.type ? (splitList(opts.type) as PostType[]) : undefined,
        reader: opts.reader ? String(opts.reader) : undefined,
        includeDerived: opts.derived !== false,
      });
      if (opts.cursorFile) writeFileSync(String(opts.cursorFile), result.nextCursor, "utf8");
      if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
      if (result.recovered) console.log("note: feed db was corrupt and has been reset (backup kept alongside).");
      if (result.items.length === 0) console.log("(feed is empty for this project)");
      for (const item of result.items) {
        const p = item.post;
        const marker = p.lifecycle.validity === "drifted" ? " [drifted]" : "";
        console.log(`[${p.type}]${marker} ${p.body.title} (${p.author.name ?? p.author.session}, ${relativeTime(p.lifecycle.createdAt)})`);
        if (item.presentation === "full" && p.body.text) console.log(indent(p.body.text));
        if (item.presentation === "full" && p.scope.paths.length) console.log(indent(`paths: ${p.scope.paths.join(", ")}`));
        console.log(indent(`id: ${p.id}`));
      }
      if (result.omitted > 0) console.log(`(${result.omitted} more below the fold; raise --budget or peek expand <id>)`);
      if (result.derivedErrors.length > 0) console.log(`(derived skipped: ${result.derivedErrors.join("; ")})`);
      if (!opts.cursorFile) console.log(`nextCursor: ${result.nextCursor}`);
    });

  cli.command("expand <postId>", "Show one feed post in full, with evidence references.")
    .usage("expand <postId> [--dir <path>] [--json]")
    .example("peek expand 01j9xq-ab12cd34")
    .option("--dir <path>", "Project directory. Defaults to cwd.")
    .option("--json", "Machine-readable output")
    .action(async (postId, opts) => {
      const { expandPost } = await import("../feed/index.js");
      const dir = resolve(String(opts.dir ?? process.cwd()));
      const post = await expandPost({ dir, postId: String(postId) });
      if (opts.json) { console.log(JSON.stringify(post, null, 2)); return; }
      console.log(`[${post.type}] ${post.body.title}`);
      console.log(indent(`author: ${post.author.name ?? post.author.session} (${relativeTime(post.lifecycle.createdAt)}, validity: ${post.lifecycle.validity})`));
      if (post.body.text) console.log(indent(post.body.text));
      for (const ev of post.body.evidence) {
        console.log(indent(`evidence: ${ev.kind} ${ev.path ?? ev.ref ?? ""}${ev.line ? `:${ev.line}` : ""}`));
      }
    });

  cli.command("doctor", "Explain adapter availability, missing paths, dependencies, and opt-in terminal capture.")
    .example("peek doctor")
    .example("peek doctor --json")
    .option("--json", "Output machine-readable diagnostic JSON")
    .option("--color", "Force colour even when piped")
    .option("--width <n>", "Render at this width instead of the terminal width")
    .action(async (opts) => {
      const rows = await doctorRows();
      const seen = await adaptersWithSessions();
      const agents = (await listAgents()).filter((a) => isPresent(a, seen));
      const divergence = await manifestDivergence(sharedLibraryRoot());
      if (opts.json) { console.log(JSON.stringify({ adapters: rows, agents, divergence }, null, 2)); return; }
      await renderDoctor(rows, agents, {
        version: VERSION,
        color: Boolean(opts.color),
        width: opts.width === undefined ? undefined : Number(opts.width),
      });
      await printManifestDivergence();
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
        next: ["peek help", "peek list", "peek doctor"],
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

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME ?? homedir();
  if (path.startsWith("~/")) return join(process.env.HOME ?? homedir(), path.slice(2));
  return path;
}

async function adaptersWithSessions(): Promise<Set<string>> {
  try {
    const engine = await createEngine({ withExternal: true });
    const sessions = await engine.list({});
    return new Set(sessions.map((s) => s.adapter));
  } catch {
    return new Set();
  }
}

async function printAgentsCommand(opts: { all: boolean; json: boolean; color?: boolean; width?: number }): Promise<void> {
  const agents = await listAgents();
  const seen = await adaptersWithSessions();
  const present = agents.filter((a) => isPresent(a, seen));
  const shown = opts.all ? agents : present;
  if (opts.json) {
    console.log(JSON.stringify({ source: AGENT_TABLE_SOURCE, agents: shown }, null, 2));
    return;
  }
  await renderAgents(agents, {
    groups: opts.all ? ["present", "unconfirmed", "absent", "no-convention"] : undefined,
    color: opts.color,
    width: opts.width,
    source: AGENT_TABLE_SOURCE,
  });
}



async function skillsMutationCommand(
  action: "archive" | "restore" | "archives",
  selector: string | undefined,
  opts: { agent?: string; allAgents?: boolean; yes?: boolean; json?: boolean },
): Promise<void> {
  if (action === "archives") {
    const records = await readArchiveLog();
    if (opts.json) { console.log(JSON.stringify(records, null, 2)); return; }
    if (records.length === 0) { console.log("nothing archived"); return; }
    for (const record of records) {
      console.log(`${record.id}  ${record.skillName}  ${record.archivedAt}`);
      for (const a of record.actions) console.log(`  ${a.kind}  ${a.agent ?? "-"}  ${formatPath(a.path)}`);
    }
    return;
  }
  if (!selector) {
    fail({
      code: 5,
      error: "missing_selector",
      message: `\`peek skills ${action}\` needs a skill name or key.`,
      hint: "Run `peek skills --json` to see names and keys.",
      next: ["peek skills --json", `peek skills ${action} <name>`],
    });
  }

  try {
    if (action === "restore") {
      const record = findArchive(await readArchiveLog(), selector);
      if (!opts.yes) {
        console.log(`would restore ${record.skillName} (archived ${record.archivedAt}):`);
        for (const a of record.actions) {
          console.log(`  ${a.kind === "move" ? "move back" : "re-link"}  ${formatPath(a.path)}`);
        }
        console.log("");
        console.log("re-run with --yes to execute");
        return;
      }
      await executeRestore(record);
      console.log(`restored ${record.skillName}`);
      return;
    }

    const inventory = await buildInventory({});
    const plan = planArchive(inventory, selector, {
      agent: opts.agent,
      allAgents: Boolean(opts.allAgents),
    });
    if (!opts.yes) {
      printArchivePlan(plan);
      return;
    }
    const record = await executeArchive(plan);
    console.log(`archived ${record.skillName} (${record.id})`);
    console.log(`restore with: peek skills restore ${record.skillName} --yes`);
  } catch (e) {
    if (e instanceof ArchiveRefusedError) {
      fail({
        code: 5,
        error: e.reason,
        message: e.message,
        hint: "peek refuses rather than guessing which installation you meant.",
        next: e.detail.length ? e.detail.map((d) => `  ${d}`) : ["peek skills --json"],
      });
    }
    throw e;
  }
}

function printArchivePlan(plan: ArchivePlan): void {
  console.log(`would archive ${plan.skillName}:`);
  for (const action of plan.actions) {
    const verb = action.kind === "unlink"
      ? "unlink (content lives elsewhere)"
      : "move    (this is the content)";
    console.log(`  ${verb}  ${action.agent ?? "-"}  ${formatPath(action.path)}`);
  }
  for (const skip of plan.skipped) {
    console.log(`  skip    ${skip.agent ?? "-"}  ${formatPath(skip.path)}  (${skip.reason})`);
  }
  for (const warning of plan.warnings) console.log(`  warning: ${warning}`);
  console.log("");
  console.log("nothing has changed. Re-run with --yes to execute.");
}


async function printManifestDivergence(): Promise<void> {
  const divergence = await manifestDivergence(sharedLibraryRoot());
  if (!divergence) return;
  const { presentButUnlisted, listedButMissing } = divergence;
  if (!presentButUnlisted.length && !listedButMissing.length) return;
  console.log("");
  console.log(`shared library manifest ${formatPath(divergence.manifestPath)} is out of step.`);
  console.log("  peek reads it and never writes it.");
  if (presentButUnlisted.length) console.log(`  on disk but unlisted: ${presentButUnlisted.length}`);
  if (listedButMissing.length) console.log(`  listed but missing: ${listedButMissing.length}`);
}

/**
 * Projects to survey: the ones named on the command line, or — by default — the
 * repositories peek has recorded work in. Explicit beats discovered, so `--projects`
 * turns discovery off rather than adding to it.
 */
async function resolveProjectSurvey(
  raw: unknown,
): Promise<{ projects: string[]; discovery?: { found: number; capped: boolean } }> {
  const named = String(raw ?? "").split(",").map((p) => p.trim()).filter(Boolean)
    .map((p) => resolve(expandHome(p)));
  if (named.length) return { projects: named };
  if (!existsSync(usageDbPath())) return { projects: [] };
  const store = new UsageStore({});
  try {
    const discovered = discoverProjects(store);
    return { projects: discovered.projects, discovery: { found: discovered.found, capped: discovered.capped } };
  } finally {
    store.close();
  }
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
  if (e instanceof PostRejectedError) {
    fail({
      code: 5,
      error: "post_rejected",
      message: e.message,
      hint: "Posts are token-budgeted context units. Shorten the body and link evidence instead of inlining it.",
      next: ["peek post --help"],
    });
  }
  if (e instanceof PostNotFoundError) {
    fail({
      code: 2,
      error: "post_not_found",
      message: e.message,
      hint: "Use `peek feed --json` to list current post ids.",
      next: ["peek feed --json"],
    });
  }
  if (e instanceof NotAProjectError) {
    fail({
      code: 5,
      error: "not_a_project",
      message: e.message,
      hint: "Pass an existing directory with --dir or run from inside the project.",
      next: ["peek feed --help"],
    });
  }
  const err = e as Error;
  if (err?.name === "CACError") {
    fail({
      code: 5,
      error: "invalid_usage",
      message: err.message,
      hint: "Run command help for the expected arguments and options.",
      next: ["peek help", "peek list --help", "peek at --help"],
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
  ignoredOwner?: string,
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
    .filter((session) => !ignoredOwner || session.adapter !== "claim" || session.displayName !== `claim-${ignoredOwner}`)
    .map((session) => ({
      id: session.id,
      displayName: session.displayName,
      adapter: session.adapter,
      status: session.status,
      currentTask: session.currentTask,
      lastWritingAt: session.writingFileEvents.find((event) => event.file === target && event.active)?.lastWritingAt,
    }));
}

function checkTargets(file: unknown, filesFrom: unknown, cwd: string): string[] {
  const values: string[] = [];
  if (file !== undefined) values.push(String(file));
  if (filesFrom !== undefined) values.push(...readFilesFrom(String(filesFrom)));
  if (values.length === 0) {
    fail({
      code: 5,
      error: "invalid_usage",
      message: "Provide a file argument or --files-from.",
      hint: "Use `peek check src/file.ts` for one file, or `peek check --files-from changed-files.txt` for bulk checks.",
      next: ["peek check src/core/engine.ts", "peek check --files-from changed-files.txt"],
    });
  }
  return [...new Set(values.map((value) => resolve(cwd, value)))].sort();
}

function readFilesFrom(path: string): string[] {
  const raw = path === "-"
    ? readFileSync(0, "utf8")
    : readFileSync(path, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * `peek usage`. Defaults to skills rather than to every tool: a primitive whose default
 * answer is always "Bash, a lot" is one nobody runs twice. The header states what the
 * numbers are conditional on, and is load-bearing — every count is scoped to the window
 * peek has been able to observe, and the likeliest way this command does harm is a user
 * reading "wayfinder: 3" as "3 ever" rather than "3 in the 32 days peek can see".
 */
async function runUsage(dimension: unknown, opts: Record<string, unknown>): Promise<void> {
  const store = new UsageStore({});
  try {
    if (opts.scan !== false) {
      const engine = await createEngine({ withExternal: true });
      const adapters = engine.adapters();
      // adapter -> agent slug. They are orthogonal (ticket 02): an adapter may belong
      // to no agent, so an unmapped adapter records a null agent rather than guessing.
      const agentByAdapter = new Map<string, string>();
      for (const agent of await listAgents()) {
        if (agent.adapter) agentByAdapter.set(agent.adapter, agent.slug);
      }
      const wasEmpty = store.isEmpty();
      if (wasEmpty && !opts.json) {
        // Bootstrap parses every transcript once; later scans resume from a watermark.
        console.error("[agent-peek] first run: indexing existing transcripts, this happens once.");
      }
      const result = await scanAll(adapters, store, {
        agentFor: (entry) => agentByAdapter.get(entry.adapter) ?? null,
      });
      for (const err of result.errors.slice(0, 3)) {
        console.error(`[agent-peek] ${err.sourcePath}: ${err.message}`);
      }
    }

    const groupBy = parseDimensions(dimension, opts.by);
    const explicitTool = opts.tool as string | undefined;
    // The default is "skill invocations", not `tool = Skill`: a slash invocation stores
    // the command name in `tool`, so filtering by tool name drops every slash-only
    // skill — 14 of them on the machine this was built against.
    const skillsOnly = !opts.allTools && explicitTool === undefined;
    // Built-in resolution is a row predicate handed to the report, not a pass over its
    // output: filtering after the limit would silently trim the tail a second time.
    const keepRow = skillsOnly && !opts.includeBuiltins
      ? await cliBuiltinRowFilter(groupBy)
      : undefined;
    const filter = {
      ...(skillsOnly ? { skillsOnly: true } : {}),
      ...(explicitTool ? { tool: explicitTool } : {}),
      ...(opts.skill ? { skill: String(opts.skill) } : {}),
      ...(opts.agent ? { agent: String(opts.agent) } : {}),
      ...(opts.adapter ? { adapter: String(opts.adapter) } : {}),
      ...(opts.cwd ? { cwd: resolve(String(opts.cwd)) } : {}),
      ...(opts.since ? { since: parseWhen(opts.since, "--since") } : {}),
      ...(opts.until ? { until: parseWhen(opts.until, "--until") } : {}),
      ...(opts.sidechain ? { sidechain: true } : {}),
      ...(opts.mainLoop ? { sidechain: false } : {}),
      ...(opts.attributionAgent ? { attributionAgent: String(opts.attributionAgent) } : {}),
    };
    const report = await buildUsageReport(store, {
      ...filter,
      groupBy,
      limit: parseLimit(opts.limit),
    }, keepRow ? { keepRow } : {});

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    // Series for the sparkline column, computed against the same filters as the rows so
    // the shape describes exactly what is listed.
    let shape: { series: Map<string, number[]>; days: number; cells: number } | undefined;
    if (groupBy.length === 1 && groupBy[0] !== "day") {
      const seriesStore = new UsageStore({});
      try {
        shape = usageSeriesFor(seriesStore, filter, groupBy[0]!);
      } finally {
        seriesStore.close();
      }
    }
    await renderUsageReport(report, groupBy, {
      ...(shape ? { series: shape.series, seriesDays: shape.days, seriesCells: shape.cells } : {}),
      ...(opts.width ? { width: Number(opts.width) } : {}),
      ...(opts.color ? { color: true } : {}),
      verbose: Boolean(opts.verbose),
    });
  } finally {
    store.close();
  }
}

/**
 * A row predicate dropping names that resolve to a CLI built-in. The index records
 * every slash command verbatim, built-ins included — ticket 01 deliberately left "is
 * this a skill" to the inventory rather than freezing an answer into the schema, and
 * this is where that resolution happens.
 *
 * Only a grouping that names something can be resolved; any other passes everything
 * through rather than filtering on a name its rows do not carry.
 */
async function cliBuiltinRowFilter(groupBy: GroupBy[]): Promise<((row: UsageRow) => boolean) | undefined> {
  // The rule itself lives in src/skills/resolve.ts, shared with the MCP surface: two
  // copies of a coverage rule is how one of them starts reporting `/clear` as a skill.
  const dim = groupBy.length === 1 ? groupBy[0] : undefined;
  return builtinRowFilter<UsageRow>(buildNameIndex(await buildInventory({})), dim);
}

function parseDimensions(dimension: unknown, by: unknown): GroupBy[] {
  const raw = by !== undefined ? String(by) : dimension !== undefined ? String(dimension) : "skill";
  const dims = raw.split(",").map((d) => d.trim()).filter(Boolean);
  const invalid = dims.filter((d) => !GROUP_BY_DIMENSIONS.includes(d as GroupBy));
  if (invalid.length > 0) {
    fail({
      code: 5,
      error: "invalid_dimension",
      message: `Unknown usage dimension: ${invalid.join(", ")}`,
      hint: `Valid dimensions: ${GROUP_BY_DIMENSIONS.join(", ")}.`,
      next: ["peek usage skill", "peek usage attributionAgent --sidechain"],
    });
  }
  return dims as GroupBy[];
}

/** Accepts a duration (30d, 24h) or an ISO date, since the retention window makes both natural. */
function parseWhen(value: unknown, flag: string): string {
  const text = String(value ?? "").trim();
  if (/^\d+(ms|s|m|h|d)?$/i.test(text)) {
    return new Date(Date.now() - parseDurationMs(text, flag)).toISOString();
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    fail({
      code: 5,
      error: "invalid_time",
      message: `Invalid ${flag}: ${text}`,
      hint: "Use a duration like 7d or 24h, or an ISO date like 2026-08-01.",
      next: ["peek usage --since 7d", "peek usage --since 2026-08-01"],
    });
  }
  return new Date(parsed).toISOString();
}

function parseLimit(value: unknown): number {
  if (value === undefined) return 20;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    fail({
      code: 5, error: "invalid_limit", message: `Invalid --limit: ${String(value)}`,
      hint: "Use a positive integer.", next: ["peek usage --limit 50"],
    });
  }
  return n;
}






/**
 * The `--json` envelope. Additive over the inventory: every existing key is preserved,
 * and each skill gains the `segment` it falls in plus the `reason` it is there.
 *
 * Without this a consumer cannot reproduce the segmentation that makes the tool safe to
 * act on — the human report says a skill is safe to archive and the JSON does not say
 * which bucket anything is in, so a script, an MCP caller, or anyone verifying has to
 * re-derive the rules or guess. Verifying "no archivable row lacks a mutable
 * installation" from the outside was impossible before this; it is now a filter.
 */
async function skillsJson(inventory: Inventory): Promise<Record<string, unknown>> {
  const agents = await listAgents();
  const store = new UsageStore({});
  let joined;
  try { joined = joinUsage(store, inventory, agents); } finally { store.close(); }
  const report = buildSkillsReport({ ...joined, skills: inventory.skills, costBasis: inventory.costBasis });

  const placement = new Map<string, { segment: string; reason: string }>();
  for (const segment of report.segments) {
    for (const row of segment.rows) placement.set(row.key, { segment: segment.id, reason: row.reason });
  }

  return {
    ...inventory,
    skills: inventory.skills.map((skill) => ({
      ...skill,
      ...(placement.get(skill.key) ?? { segment: "unknown-usage", reason: "unclassified" }),
    })),
    // The same summary the human sees, so a consumer never re-derives it.
    segments: report.segments.map((segment) => ({
      id: segment.id, title: segment.title, note: segment.note,
      count: segment.rows.length, tokens: segment.tokens,
    })),
    unmatched: report.unmatched,
  };
}

/**
 * `peek skills` printed report. Segmented by what the user can act on, because this is
 * the screen that deletes things: a skill is offered only when every one of its rows can
 * be rendered honestly, and excluded otherwise. Segmentation carries the honesty so the
 * common rows need no caveat.
 */
async function runSkillsReport(opts: Record<string, unknown>): Promise<void> {
  const { projects, discovery } = await resolveProjectSurvey(opts.projects);
  const inventory = await buildInventory({ projects, projectDiscovery: discovery });
  const agents = await listAgents();
  const store = new UsageStore({});
  let joined;
  let shape: { series: Map<string, number[]>; days: number };
  try {
    joined = joinUsage(store, inventory, agents);
    shape = usageSeries(store, inventory);
  } finally {
    store.close();
  }
  const input = { ...joined, skills: inventory.skills, costBasis: inventory.costBasis };
  const report = buildSkillsReport(input);

  const selector = typeof opts.skill === "string" ? opts.skill : undefined;
  if (selector) {
    const skill = inventory.skills.find((s) => s.name === selector || s.key === selector
      || s.qualifiedName === selector);
    if (!skill) {
      fail({
        code: 4, error: "skill_not_found", message: `No skill named ${selector}`,
        hint: "Use the name as it appears in `peek skills`.", next: ["peek skills"],
      });
      return;
    }
    printSkillExpansion(skill.name, expandSkill(input, skill));
    return;
  }

  const rowLimit = opts.limit === undefined ? undefined : parseRequiredPositive(opts.limit, "--limit");
  const blindAgents = agents.filter((a) => a.roots.some((r) => r.present) && !a.attributable).length;
  const view = {
    ...(opts.width ? { width: Number(opts.width) } : {}),
    ...(opts.color ? { color: true } : {}),
    ...(rowLimit === undefined ? {} : { limit: rowLimit }),
    series: shape.series,
    seriesDays: shape.days,
    blindAgents,
  };
  if (typeof opts.segment === "string") {
    await renderSkillsSegment(report, opts.segment, view);
    return;
  }
  await renderSkillsReport(report, view);
}

/**
 * The per-installation view (ticket 07 variant B, as the expansion of one row). This is
 * where unlink-versus-retire has to be visible: unlinking one agent is a different act
 * from retiring a skill everywhere, and neither can be chosen without seeing the others.
 */
function printSkillExpansion(name: string, rows: InstallationRow[]): void {
  console.log(`${name} — ${rows.length} installation${rows.length === 1 ? "" : "s"}`);
  console.log("");
  const table = rows.map((row) => [
    row.agent, row.usesLabel, row.coverage,
    row.action === "refuse" ? "refuses (read-only)" : row.action === "unlink" ? "unlink" : "move to archive",
    String(row.tokens), formatPath(row.path).slice(0, 52),
  ]);
  const headers = ["AGENT", "USED", "COVERAGE", "ARCHIVE WOULD", "TOKENS", "PATH"];
  const cols = headers.map((h, i) => Math.max(h.length, ...table.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((v, i) => v.padEnd(cols[i]!)).join("  ").trimEnd();
  console.log(fmt(headers));
  for (const row of table) console.log(fmt(row));
  console.log("");
  console.log("Nothing has been changed. Archiving is per installation:");
  console.log(`  peek skills archive ${name} --agent <slug>   one agent only`);
  console.log(`  peek skills archive ${name} --all-agents     every mutable installation`);
  console.log("Both describe the plan and stop; add --yes to execute.");
}

function parseDurationMs(value: unknown, flag: string): number {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) {
    fail({
      code: 5,
      error: "invalid_duration",
      message: `Invalid ${flag}: ${text}`,
      hint: "Use a duration like 30s, 2m, 1h, or 7d.",
      next: ["peek claim src/core/engine.ts --ttl 2m"],
    });
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const factor = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1;
  const ms = amount * factor;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    fail({
      code: 5,
      error: "invalid_duration",
      message: `Invalid ${flag}: ${text}`,
      hint: "Duration must be positive.",
      next: ["peek claim src/core/engine.ts --ttl 2m"],
    });
  }
  return ms;
}

function splitList(value: unknown): string[] {
  if (value === undefined) return [];
  return String(value).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseEvidence(value: unknown): { kind: "file" | "commit" | "session"; path?: string; line?: number; ref?: string }[] {
  return splitList(value).map((entry) => {
    const [kind, ...rest] = entry.split(":");
    if (kind === "file") {
      const line = rest.length > 1 && /^\d+$/.test(rest[rest.length - 1]!) ? Number(rest.pop()) : undefined;
      return { kind: "file" as const, path: rest.join(":"), line };
    }
    if (kind === "commit" || kind === "session") return { kind, ref: rest.join(":") };
    throw new PostRejectedError(`evidence "${entry}" must start with file:, commit:, or session:`);
  });
}

async function defaultClaimOwner(): Promise<string> {
  const author = await resolveAuthor({ cwd: process.cwd() });
  if (!author.anonymous) return author.session;
  return `${userInfo().username || "agent"}@${hostname()}:${process.pid}`;
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

function printFocusedHelp(command?: string): void {
  const commands: Record<string, string[]> = {
    list: [
      "peek list                         # show active local sessions",
      "peek list --json                  # script-friendly session list",
      "peek list --files                 # include active/recent file context",
      "peek list adapters                # show adapter names",
    ],
    at: [
      "peek at <selector> --mode brief       # compact local status",
      "peek at <selector> --mode structured  # stable fields for agents",
      "peek at <selector> --mode handoff     # decisions, files, next actions",
      "peek at <selector> --last 50 --tools  # inspect raw transcript details",
    ],
    coord: [
      "peek coord . --writing",
      "peek coord . --json --fields currentTask,intent,activeWritingFiles",
      "peek coord . --since-file .peek-cursor --json",
    ],
    check: [
      "peek check src/core/engine.ts",
      "peek check --files-from changed-files.txt",
      "peek check docs/demo.mp4 --as demo-agent",
    ],
    claim: [
      "peek claim src/core/engine.ts --ttl 2m --as codex-main",
      "peek claim src/core/engine.ts --files-from changed-files.txt --ttl 2m",
    ],
    release: [
      "peek release src/core/engine.ts",
      "peek release <claim-id> --claim-id --json",
    ],
    doctor: [
      "peek doctor",
      "peek doctor --json",
    ],
    update: [
      "peek version",
      "peek update              # install agent-peek@latest globally",
      "peek update --check      # check only",
      "npm install -g agent-peek@latest",
    ],
  };

  if (command) {
    const lines = commands[command];
    if (!lines) {
      fail({
        code: 5,
        error: "unknown_help_topic",
        message: `Unknown help topic: ${command}`,
        hint: "Use `peek help` for the overview, or `peek <command> --help` for full command options.",
        next: ["peek help", "peek list --help", "peek coord --help"],
      });
    }
    console.log(`peek ${command}`);
    console.log("");
    for (const line of lines) console.log(line);
    console.log("");
    console.log(`Full options: peek ${command} --help`);
    return;
  }

  console.log("agent-peek");
  console.log("Read-only visibility and coordination for local AI agent sessions.");
  console.log("");
  console.log("Common commands:");
  console.log("  peek list                         show active sessions");
  console.log("  peek at <selector> --mode brief   read one session without touching it");
  console.log("  peek coord . --writing            see active writers in this repo");
  console.log("  peek check <file>                 exit 1 if another agent is writing it");
  console.log("  peek claim <file> --ttl 2m        broadcast temporary write intent");
  console.log("  peek release <claim-id> --claim-id");
  console.log("  peek ui                           browse sessions interactively");
  console.log("  peek doctor                       diagnose adapter availability");
  console.log("  peek version                      show installed version");
  console.log("  peek update                       install the latest npm version globally");
  console.log("");
  console.log("Focused help:");
  console.log("  peek help coord");
  console.log("  peek help check");
  console.log("  peek help update");
  console.log("");
  console.log("Full options:");
  console.log("  peek <command> --help");
}

interface UpdateInfo {
  name: "agent-peek";
  current: string;
  latest?: string;
  status: "up-to-date" | "update-available" | "unknown";
  command: string;
  error?: string;
}

interface UpdateResult extends UpdateInfo {
  installStatus: "skipped" | "installed" | "failed";
  stdout?: string;
  stderr?: string;
}

async function updateInfo(): Promise<UpdateInfo> {
  const command = "npm install -g agent-peek@latest";
  try {
    const latest = await latestNpmVersion();
    return {
      name: "agent-peek",
      current: VERSION,
      latest,
      status: compareVersions(latest, VERSION) > 0 ? "update-available" : "up-to-date",
      command,
    };
  } catch (e) {
    return {
      name: "agent-peek",
      current: VERSION,
      status: "unknown",
      command,
      error: (e as Error)?.message ?? String(e),
    };
  }
}

async function performUpdate(info: UpdateInfo, opts: { force?: boolean }): Promise<UpdateResult> {
  if (!opts.force && info.status === "up-to-date") {
    return { ...info, installStatus: "skipped" };
  }
  try {
    const { stdout, stderr } = await execFileAsync("npm", ["install", "-g", "agent-peek@latest"], {
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ...info,
      installStatus: "installed",
      stdout: stdout.trim() || undefined,
      stderr: stderr.trim() || undefined,
    };
  } catch (e) {
    const err = e as Error & { stdout?: string; stderr?: string };
    return {
      ...info,
      installStatus: "failed",
      error: err.message,
      stdout: err.stdout?.trim() || undefined,
      stderr: err.stderr?.trim() || undefined,
    };
  }
}

async function latestNpmVersion(): Promise<string> {
  const override = process.env.AGENT_PEEK_LATEST_VERSION;
  if (override) return override.trim();
  const { stdout } = await execFileAsync("npm", ["view", "agent-peek", "version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const latest = stdout.trim();
  if (!latest) throw new Error("npm returned an empty version");
  return latest;
}

function printUpdateInfo(info: UpdateInfo): void {
  console.log(`agent-peek ${info.current}`);
  if (info.latest) console.log(`latest ${info.latest}`);
  else console.log("latest unavailable");
  console.log(`status ${info.status}`);
  if (info.status === "update-available") console.log(`run: ${info.command}`);
  else if (info.status === "unknown") {
    console.log(`run: ${info.command}`);
    if (info.error) console.log(`note: could not check npm (${oneLine(info.error)})`);
  }
}

function printUpdateResult(result: UpdateResult): void {
  printUpdateInfo(result);
  if (result.installStatus === "skipped") {
    console.log("install skipped: already up to date");
    return;
  }
  if (result.installStatus === "installed") {
    console.log("install complete");
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    return;
  }
  console.log("install failed");
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = 1;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const l = Number.isFinite(left[i]) ? left[i]! : 0;
    const r = Number.isFinite(right[i]) ? right[i]! : 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
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


function isTerminalAdapter(adapter: unknown): boolean {
  return typeof adapter === "string" && TERMINAL_ADAPTERS.has(adapter);
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
  const diffMs = then - Date.now();
  if (diffMs > 0) {
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) return `in ${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `in ${days}d`;
    return iso.slice(0, 10);
  }
  const seconds = Math.max(0, Math.floor(-diffMs / 1000));
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
