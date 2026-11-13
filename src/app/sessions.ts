// src/app/sessions.ts
//
// Session discovery and reads, as every front end asks for them. The rules that used to
// be repeated in the CLI and the stdio MCP server live here: which sessions a listing
// hides by default, how display names are attached, when terminal capture is included,
// and how a raw read widens until enough visible messages fit.
import type { Engine, PeekOpts, RegisterOpts } from "../core/engine.js";
import { displayNames } from "../core/names.js";
import type { PeekResult, SessionEntry } from "../core/types.js";
import { isTerminalAdapter } from "./adapters.js";

export type SessionStatus = SessionEntry["status"];

export const SESSION_STATUSES: readonly SessionStatus[] = ["active", "idle", "ended"];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

/**
 * Terminal capture (tmux, screen) is opt-in, except when the caller names a terminal
 * adapter: asking for `--adapter tmux` is asking for terminals.
 */
export function includesTerminals(opts: { includeTerminal?: boolean; adapter?: string }): boolean {
  return opts.includeTerminal === true || isTerminalAdapter(opts.adapter);
}

type Nameable = { id: string; name?: string; tag?: string; adapter: string; cwd?: string };

/**
 * Attach the display name each session is addressed by. `fillName` also sets a missing
 * `name` to it: the CLI's JSON lets a consumer key on one field, while the MCP result has
 * always left `name` as the adapter reported it. Both shapes are recorded contracts.
 */
export function withDisplayNames<T extends Nameable>(
  list: T[],
  opts: { fillName?: boolean } = {},
): (T & { displayName: string })[] {
  const names = displayNames(list);
  return list.map((entry, i) => opts.fillName
    ? { ...entry, name: entry.name ?? names[i]!, displayName: names[i]! }
    : { ...entry, displayName: names[i]! });
}

export interface ListSessionsOpts {
  adapter?: string;
  status?: SessionStatus;
  /** Keep ended sessions when no status is given. */
  includeEnded?: boolean;
  includeTerminal?: boolean;
  /**
   * Drop sessions spawned by another session. Discovery is truthful and the view is
   * opinionated: subagents roughly triple a machine's list, so the CLI hides them by
   * default. The MCP tool has always listed them, and keeps doing so.
   */
  hideSubagents?: boolean;
}

/** The read-only views the MCP resources expose for one session. */
export type SessionView = "brief" | "handoff" | "tail";

export interface WidenedWindow {
  /** Messages the widened window ended up holding. */
  messages: number;
  /** Visible messages the caller asked for. */
  wanted: number;
}

/** Hard ceiling on how far a raw window widens looking for visible messages. */
const MAX_WIDENED_LIMIT = 5000;

export class SessionsService {
  constructor(private readonly engine: Engine) {}

  adapterNames(): string[] {
    return this.engine.adapterNames();
  }

  async list(opts: ListSessionsOpts = {}): Promise<SessionEntry[]> {
    let list = await this.engine.list({
      adapter: opts.adapter,
      status: opts.status,
      includeTerminal: includesTerminals(opts),
    });
    if (!opts.status && !opts.includeEnded) list = list.filter((entry) => entry.status !== "ended");
    if (opts.hideSubagents) list = list.filter((entry) => entry.parentSessionId === undefined);
    return list;
  }

  /** Live agent sessions, without terminal capture: what MCP resources enumerate. */
  async active(): Promise<SessionEntry[]> {
    const list = await this.engine.list({ includeTerminal: false });
    return list.filter((entry) => entry.status !== "ended");
  }

  /**
   * Adapters with at least one discovered session. A failed scan yields an empty set:
   * this feeds presence hints (`agents`, `doctor`), which must not fail on a broken
   * adapter.
   */
  async adaptersWithSessions(): Promise<Set<string>> {
    try {
      const sessions = await this.engine.list({});
      return new Set(sessions.map((s) => s.adapter));
    } catch {
      return new Set();
    }
  }

  peek(selector: string, opts: PeekOpts = {}): Promise<PeekResult> {
    return this.engine.peek(selector, opts);
  }

  /**
   * A raw read where `limit` counts messages the reader will see. Tool-only rows are
   * hidden unless the caller shows tools, so the window widens until enough visible rows
   * fit or the transcript runs out; `widened` reports the span it took.
   */
  async peekVisible(
    selector: string,
    opts: PeekOpts,
    view: { showTools: boolean },
  ): Promise<{ result: PeekResult; widened?: WidenedWindow }> {
    let result = await this.engine.peek(selector, opts);
    if (result.snapshot.mode !== "raw" || view.showTools || opts.limit === undefined || opts.around !== undefined) {
      return { result };
    }
    const wanted = opts.limit;
    let limit = wanted;
    let snap = result.snapshot;
    while (
      snap.messages.filter((m) => m.text).length < wanted
      && snap.messages.length < snap.totalMessageCount
      && limit < MAX_WIDENED_LIMIT
    ) {
      limit = Math.min(MAX_WIDENED_LIMIT, limit * 3);
      result = await this.engine.peek(selector, { ...opts, limit });
      if (result.snapshot.mode !== "raw") break;
      snap = result.snapshot;
    }
    return limit === wanted ? { result } : { result, widened: { messages: snap.messages.length, wanted } };
  }

  view(selector: string, view: SessionView): Promise<PeekResult> {
    if (view === "brief") return this.engine.peek(selector, { mode: "brief" });
    if (view === "handoff") return this.engine.peek(selector, { mode: "handoff", produce: "material" });
    return this.engine.peek(selector, { mode: "raw", limit: 50 });
  }

  tag(selector: string, tag: string): Promise<void> {
    return this.engine.tag(selector, tag);
  }

  untag(selector: string): Promise<void> {
    return this.engine.untag(selector);
  }

  register(opts: RegisterOpts): Promise<SessionEntry> {
    return this.engine.register(opts);
  }

  forget(id: string): Promise<void> {
    return this.engine.unregister(id);
  }
}
