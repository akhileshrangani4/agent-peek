// src/adapters/loader.ts
import { pathToFileURL } from "node:url";
import type { Adapter } from "./types.js";
import { AdapterNotFoundError } from "../core/errors.js";

export class AdapterLoader {
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
      // eslint-disable-next-line no-console
      console.warn(`[agent-peek] failed to load adapter from ${p}: ${(e as Error).message}`);
    }
  }
}
