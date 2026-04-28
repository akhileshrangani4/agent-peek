// src/cli/index.ts
import { cac } from "cac";
import { createEngine, VERSION } from "../index.js";
import {
  SessionNotFoundError, AmbiguousSelectorError,
  AdapterError, AdapterNotFoundError, RegistryLockTimeoutError,
} from "../core/errors.js";
import type { SnapshotMode } from "../core/types.js";

export async function run(argv: string[] = process.argv): Promise<number> {
  const cli = cac("peek");

  cli.command("list", "List discovered sessions")
    .option("--adapter <name>", "Filter by adapter")
    .option("--status <s>", "Filter by status (active|idle|ended)")
    .option("--json", "Output JSON")
    .action(async (opts) => {
      const engine = await createEngine({ withExternal: true });
      const list = await engine.list({ adapter: opts.adapter, status: opts.status });
      if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
      printList(list);
    });

  cli.command("peek <selector>", "Show snapshot of a session")
    .option("--mode <m>", "raw|structured|summary", { default: "raw" })
    .option("--since <cursor>", "Only return new messages after this cursor")
    .option("--limit <n>", "Max raw messages", { default: 200 })
    .option("--json", "Output JSON")
    .action(async (selector, opts) => {
      const engine = await createEngine({ withExternal: true });
      const r = await engine.peek(selector, {
        mode: opts.mode as SnapshotMode,
        since: opts.since,
        limit: Number(opts.limit) || undefined,
      });
      if (opts.json) { console.log(JSON.stringify(r, null, 2)); return; }
      printSnapshot(r);
    });

  cli.command("tag <id> <name>", "Set a friendly tag for a session")
    .action(async (id, name) => {
      const engine = await createEngine();
      await engine.tag(id, name);
      console.log(`tagged ${id} as ${name}`);
    });

  cli.command("untag <id>", "Remove a session's tag")
    .action(async (id) => {
      const engine = await createEngine();
      await engine.untag(id);
      console.log(`untagged ${id}`);
    });

  cli.command("register", "Register a session manually")
    .option("--id <id>", "Session id (must be adapter-prefixed)", { default: "" })
    .option("--adapter <name>", "Adapter name", { default: "" })
    .option("--transcript-path <p>", "Absolute transcript path", { default: "" })
    .option("--as <tag>", "Tag/name for the session", { default: "" })
    .option("--cwd <path>", "Working directory", { default: "" })
    .action(async (opts) => {
      if (!opts.id || !opts.adapter || !opts.transcriptPath) {
        console.error("--id, --adapter, --transcript-path are required");
        process.exit(5);
      }
      const engine = await createEngine();
      await engine.register({
        id: opts.id, adapter: opts.adapter, transcriptPath: opts.transcriptPath,
        tag: opts.as || undefined, cwd: opts.cwd || undefined,
      });
      console.log(`registered ${opts.id}`);
    });

  cli.command("unregister <id>", "Remove a session from the registry")
    .action(async (id) => {
      const engine = await createEngine();
      await engine.unregister(id);
      console.log(`unregistered ${id}`);
    });

  cli.command("adapters", "List installed adapters")
    .action(async () => {
      const engine = await createEngine({ withExternal: true });
      const list = await engine.list();
      const seen = new Set(list.map((e) => e.adapter));
      console.log(["claude-code", "codex", ...seen].filter(Boolean).join("\n"));
    });

  cli.help();
  cli.version(VERSION);

  try {
    cli.parse(argv, { run: false });
    await cli.runMatchedCommand();
    return 0;
  } catch (e) {
    return handleError(e);
  }
}

function handleError(e: unknown): number {
  if (e instanceof SessionNotFoundError) {
    console.error(`error: ${e.message}\nhint: run \`peek list\``);
    process.exit(2);
  }
  if (e instanceof AmbiguousSelectorError) {
    console.error(`error: ${e.message}`);
    process.exit(3);
  }
  if (e instanceof AdapterError || e instanceof AdapterNotFoundError) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(4);
  }
  if (e instanceof RegistryLockTimeoutError) {
    console.error(`error: ${e.message}`);
    process.exit(5);
  }
  console.error((e as Error)?.stack ?? String(e));
  process.exit(1);
}

function printList(list: { id: string; tag?: string; adapter: string; cwd?: string; status: string; lastSeen: string }[]): void {
  if (list.length === 0) { console.log("(no sessions)"); return; }
  const rows = list.map((e) => [
    e.id, e.tag ?? "-", e.adapter, e.cwd ?? "-", e.status, e.lastSeen,
  ]);
  const headers = ["ID", "TAG", "ADAPTER", "CWD", "STATUS", "LAST SEEN"];
  const cols = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((v, i) => v.padEnd(cols[i]!)).join("  ");
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
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
