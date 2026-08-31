// src/agents/builtin.ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, InvocationKind } from "./types.js";

export interface HomeEnv {
  home?: string;
  xdgConfigHome?: string;
}

function resolveHome(env: HomeEnv): { home: string; config: string } {
  const home = env.home ?? process.env.HOME ?? homedir();
  const config = env.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return { home, config };
}

/**
 * Invocation kinds each adapter's parser can extract. Declared per adapter because
 * seeing a slash command is a property of the parser, not the product: an adapter that
 * reads structured tool calls but has no slash syntax to extract leaves human-initiated
 * usage invisible, which is a different state from "never used".
 *
 * Physically a table here rather than a field on the Adapter objects, to stay out of the
 * adapter files while the usage-index work is in flight. Folding it onto `Adapter` is a
 * post-merge cleanup.
 */
const ADAPTER_OBSERVES: Record<string, InvocationKind[]> = {
  "claude-code": ["tool_call", "slash_command"],
  codex: ["tool_call"],
  gemini: ["tool_call"],
  // goose's adapter surfaces role, text, and timestamp only: no toolCalls, so a skill
  // invocation is unattributable there. Claiming tool_call here would render every
  // goose skill "never used" rather than "cannot see usage".
  goose: [],
  opencode: ["tool_call"],
  "copilot-cli": [],
  tmux: [],
  screen: [],
};

export function adapterObserves(adapter: string | undefined): InvocationKind[] {
  if (!adapter) return [];
  return ADAPTER_OBSERVES[adapter] ?? [];
}

/**
 * The shared library root: skill directories that per-agent roots symlink into. No
 * agent's system prompt reads it, so it is not an agent. A foreign installer owns its
 * `.skill-lock.json` manifest; peek reads this tree and does not write it.
 */
export function sharedLibraryRoot(env: HomeEnv = {}): string {
  return join(resolveHome(env).home, ".agents", "skills");
}

/**
 * Candidate agents peek ships knowledge of. Roots are candidates: they are resolved
 * against disk, and an absent root is not an error. Paths are not uniform across agents
 * (goose and opencode live under XDG config), so a naming convention cannot replace an
 * explicit declaration.
 */
export function builtinAgents(env: HomeEnv = {}): Agent[] {
  const { home, config } = resolveHome(env);
  const dot = (name: string, ...rest: string[]) => join(home, `.${name}`, ...rest);
  return [
    {
      slug: "claude-code",
      displayName: "Claude Code",
      adapter: "claude-code",
      roots: [
        { path: dot("claude", "skills"), kind: "user", mutable: true },
        { path: dot("claude", "plugins"), kind: "plugin", mutable: false },
      ],
    },
    {
      slug: "codex",
      displayName: "Codex",
      adapter: "codex",
      roots: [{ path: dot("codex", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "cursor",
      displayName: "Cursor",
      roots: [{ path: dot("cursor", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "gemini",
      displayName: "Gemini CLI",
      adapter: "gemini",
      roots: [{ path: dot("gemini", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "opencode",
      displayName: "opencode",
      adapter: "opencode",
      roots: [{ path: join(config, "opencode", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "goose",
      displayName: "Goose",
      adapter: "goose",
      roots: [{ path: join(config, "goose", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "continue",
      displayName: "Continue",
      roots: [{ path: dot("continue", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "factory",
      displayName: "Factory",
      roots: [{ path: dot("factory", "skills"), kind: "user", mutable: true }],
    },
  ];
}
