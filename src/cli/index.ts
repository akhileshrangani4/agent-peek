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

  cli.command("list [target]", "List discovered sessions, or `list adapters` for adapters")
    .option("--adapter <name>", "Filter by adapter")
    .option("--status <s>", "Filter by status (active|idle|ended)")
    .option("--json", "Output JSON")
    .action(async (target, opts) => {
      if (target === "adapters") {
        await listAdapters();
        return;
      }
      if (target !== undefined) {
        console.error(`unknown list target: ${target}\nusage: peek list [adapters]`);
        process.exit(5);
      }
      const engine = await createEngine({ withExternal: true });
      const list = await engine.list({ adapter: opts.adapter, status: opts.status });
      if (opts.json) { console.log(JSON.stringify(list, null, 2)); return; }
      printList(list);
    });

  cli.command("at <selector>", "Show snapshot of a session")
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

  cli.command("tag <id> <asLiteral> <name>", "Tag a session — usage: peek tag <id> as <name>")
    .action(async (id, asLiteral, name) => {
      if (asLiteral !== "as") {
        console.error(`expected: peek tag <id> as <name>`);
        process.exit(5);
      }
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

  cli.command("register <id> <atLiteral> <path>", "Register a session — usage: peek register <id> at <path>")
    .option("--as <name>", "Tag/name for the session")
    .option("--cwd <path>", "Working directory")
    .action(async (id, atLiteral, path, opts) => {
      if (atLiteral !== "at") {
        console.error(`expected: peek register <id> at <path>`);
        process.exit(5);
      }
      const colon = id.indexOf(":");
      if (colon <= 0) {
        console.error(`id must be adapter-prefixed, e.g. "claude-code:abc-123"`);
        process.exit(5);
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

  cli.command("forget <id>", "Remove a session from the registry")
    .action(async (id) => {
      const engine = await createEngine();
      await engine.unregister(id);
      console.log(`forgot ${id}`);
    });

  cli.command("adapters", "Alias for `list adapters`")
    .action(async () => {
      await listAdapters();
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

async function listAdapters(): Promise<void> {
  const engine = await createEngine({ withExternal: true });
  const list = await engine.list();
  const seen = new Set(list.map((e) => e.adapter));
  console.log(["claude-code", "codex", ...seen].filter(Boolean).join("\n"));
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
