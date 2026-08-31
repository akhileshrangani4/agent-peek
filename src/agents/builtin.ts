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
 * Invocation kinds whose extractor can name the skill involved. Strictly a subset of
 * ADAPTER_OBSERVES: observing an invocation and attributing it to a skill are different
 * capabilities, and only claude-code does both today.
 *
 * Measured: 38,106 indexed claude-code invocations, 203 carrying a skill name; 8,237
 * codex invocations, zero. Codex records slash commands (in `response_item/message`
 * records with role "user"), so this entry becomes ["slash_command"] once an extractor
 * reads them — but not before, because an agent marked attributable while nothing
 * extracts its names reports every one of its skills as never used.
 *
 * An adapter absent from this table attributes nothing. That default is deliberate:
 * unknown collapses to unattributable, so a missing entry costs a caveat rather than a
 * wrong "never used".
 */
const ADAPTER_ATTRIBUTES: Record<string, InvocationKind[]> = {
  "claude-code": ["tool_call", "slash_command"],
  // Earned by shipping the extractor (ticket 13), not declared ahead of it: codex slash
  // commands are now read, so a codex skill invoked by hand is attributable. Its
  // tool-call path stays blind, because a skill invocation there is an `exec` like any
  // other — which is what makes codex `partial` rather than `attributed`.
  codex: ["slash_command"],
};

export function adapterAttributes(adapter: string | undefined): InvocationKind[] {
  if (!adapter) return [];
  return ADAPTER_ATTRIBUTES[adapter] ?? [];
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
      projectDir: ".claude/skills",
      honoursDisableModelInvocation: true,
      displayName: "Claude Code",
      adapter: "claude-code",
      roots: [
        { path: dot("claude", "skills"), kind: "user", mutable: true },
        // `cache` only: sibling `marketplaces/` holds catalogue checkouts of the same
        // plugins, which the agent never loads. Walking the parent counts every plugin
        // skill twice and flags 481 spurious duplicate names.
        { path: dot("claude", "plugins", "cache"), kind: "plugin", mutable: false },
      ],
    },
    {
      slug: "codex",
      projectDir: ".codex/skills",
      displayName: "Codex",
      adapter: "codex",
      roots: [{ path: dot("codex", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "cursor",
      projectDir: ".cursor/skills",
      displayName: "Cursor",
      roots: [{ path: dot("cursor", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "gemini",
      projectDir: ".gemini/skills",
      displayName: "Gemini CLI",
      adapter: "gemini",
      roots: [{ path: dot("gemini", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "opencode",
      projectDir: ".opencode/skills",
      displayName: "opencode",
      adapter: "opencode",
      roots: [{ path: join(config, "opencode", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "goose",
      projectDir: ".goose/skills",
      displayName: "Goose",
      adapter: "goose",
      roots: [{ path: join(config, "goose", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "continue",
      projectDir: ".continue/skills",
      displayName: "Continue",
      roots: [{ path: dot("continue", "skills"), kind: "user", mutable: true }],
    },
    {
      slug: "factory",
      projectDir: ".factory/skills",
      displayName: "Factory",
      roots: [{ path: dot("factory", "skills"), kind: "user", mutable: true }],
    },
  ];
}
