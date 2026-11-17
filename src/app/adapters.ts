// src/app/adapters.ts
//
// The adapter set an engine reads through: the concrete loader, the built-in adapters
// and their aliases, and external discovery. This is the composition root for adapters,
// so it lives in the app layer: core sees only the `AdapterCatalog` interface, and no
// adapter module imports this one.
import { pathToFileURL } from "node:url";
import type { Adapter, AdapterCatalog } from "../core/types.js";
import { AdapterNotFoundError } from "../core/errors.js";
import claudeCode from "../adapters/claude-code/index.js";
import codex from "../adapters/codex/index.js";
import copilotCli from "../adapters/copilot-cli/index.js";
import gemini from "../adapters/gemini/index.js";
import goose from "../adapters/goose/index.js";
import opencode from "../adapters/opencode/index.js";
import screen from "../adapters/screen/index.js";
import tmux from "../adapters/tmux/index.js";

export class AdapterLoader implements AdapterCatalog {
  private readonly adapters = new Map<string, Adapter>();
  /** Extra names that resolve to a registered adapter. Never listed by `names()`. */
  private readonly aliases = new Map<string, string>();

  register(adapter: Adapter): void {
    if (this.adapters.has(adapter.name) || this.aliases.has(adapter.name)) {
      throw new Error(`Adapter "${adapter.name}" already registered`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  /**
   * Accept `alias` wherever an adapter name is accepted (`--adapter`, a selector prefix).
   * Sessions keep the target's name and id namespace: an alias never renames anything.
   */
  alias(alias: string, target: string): void {
    if (this.adapters.has(alias) || this.aliases.has(alias)) {
      throw new Error(`Adapter "${alias}" already registered`);
    }
    if (!this.adapters.has(target)) throw new AdapterNotFoundError(target);
    this.aliases.set(alias, target);
  }

  /** The registered adapter name `name` stands for: itself, or an alias's target. */
  canonical(name: string): string {
    return this.aliases.get(name) ?? name;
  }

  get(name: string): Adapter {
    const a = this.adapters.get(this.canonical(name));
    if (!a) throw new AdapterNotFoundError(name);
    return a;
  }

  has(name: string): boolean {
    return this.adapters.has(this.canonical(name));
  }

  names(): string[] {
    return Array.from(this.adapters.keys());
  }

  all(): Adapter[] {
    return Array.from(this.adapters.values());
  }
}

/**
 * Built-in adapters in registration order. The order is observable (it is the order
 * `Engine.adapters()` scans in), so new adapters are appended, never inserted.
 */
export const BUILTIN_ADAPTERS: readonly Adapter[] = [
  claudeCode, codex, copilotCli, gemini, goose, opencode, screen, tmux,
];

/**
 * Alternative names accepted for a built-in adapter. `opencode-legacy-v1` is the name
 * lachieh's PR #12 gave legacy storage; it is kept as an alias only, so legacy sessions
 * are still listed by the opencode adapter as `opencode:<id>`.
 */
export const BUILTIN_ADAPTER_ALIASES: ReadonlyMap<string, string> = new Map([
  ["opencode-legacy-v1", "opencode"],
]);

/** Adapters that capture terminal scrollback rather than an agent transcript; opt-in. */
export const TERMINAL_ADAPTERS: ReadonlySet<string> = new Set(["tmux", "screen"]);

export function isTerminalAdapter(adapter: unknown): boolean {
  return typeof adapter === "string" && TERMINAL_ADAPTERS.has(adapter);
}

export function registerBuiltinAdapters(loader: AdapterLoader): void {
  for (const adapter of BUILTIN_ADAPTERS) loader.register(adapter);
  for (const [alias, target] of BUILTIN_ADAPTER_ALIASES) loader.alias(alias, target);
}

/**
 * Discover external adapter packages by scanning AGENT_PEEK_ADAPTER_PATH (colon-
 * separated list of paths to loadable adapter packages or .js files). Global npm
 * scan can be added later; this keeps v1 deterministic.
 */
export async function discoverExternal(loader: AdapterLoader): Promise<void> {
  const env = process.env.AGENT_PEEK_ADAPTER_PATH;
  if (!env) return;
  const paths = env.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  for (const p of paths) {
    try {
      const mod = await import(pathToFileURL(p).href);
      const adapter: Adapter | undefined = mod?.default;
      if (adapter && typeof adapter.name === "string"
          && typeof adapter.scan === "function"
          && typeof adapter.read === "function") {
        if (!loader.has(adapter.name)) loader.register(adapter);
      }
    } catch (e) {
      // A broken plugin must not take down every command, so it is reported and skipped.
      // eslint-disable-next-line no-console
      console.warn(`[agent-peek] failed to load adapter from ${p}: ${(e as Error).message}`);
    }
  }
}

export interface AdapterSetOpts {
  withBuiltins?: boolean;
  withExternal?: boolean;
}

export async function createAdapterLoader(opts: AdapterSetOpts = {}): Promise<AdapterLoader> {
  const loader = new AdapterLoader();
  if (opts.withBuiltins !== false) registerBuiltinAdapters(loader);
  if (opts.withExternal) await discoverExternal(loader);
  return loader;
}

/** Agent names people type where an adapter name belongs (`peek at claude`). */
const AGENT_WORDS: ReadonlyMap<string, string> = new Map([
  ["claude", "claude-code"],
  ["copilot", "copilot-cli"],
]);

/**
 * The built-in adapter a bare word names, if any: an adapter name, one of its aliases,
 * or the agent's everyday name. Used to explain that `peek at claude` names an adapter,
 * not a session.
 */
export function builtinAdapterNamed(word: string): string | undefined {
  const key = word.toLowerCase();
  if (BUILTIN_ADAPTERS.some((adapter) => adapter.name === key)) return key;
  // Maps, not object literals: a selector such as `constructor` must not resolve to an
  // Object.prototype member.
  return BUILTIN_ADAPTER_ALIASES.get(key) ?? AGENT_WORDS.get(key);
}
