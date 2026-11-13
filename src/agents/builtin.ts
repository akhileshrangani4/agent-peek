// src/agents/builtin.ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, GeneratedAgent, InvocationKind, SkillRoot } from "./types.js";
import { GENERATED_AGENTS, GENERATED_SOURCE } from "./generated-agents.js";

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
 * Invocation kinds each adapter's parser can extract, keyed by adapter name.
 *
 * The declaration lives on the `Adapter` objects themselves (`adapter.observes`); this
 * table mirrors it so callers can ask about an adapter without loading one. The mirror is
 * asserted against the registered adapters in the test suite, so the two cannot drift.
 */
const ADAPTER_OBSERVES: Record<string, InvocationKind[]> = {
  "claude-code": ["tool_call", "slash_command"],
  // slash_command since ticket 13: the codex extractor reads slash invocations from
  // `response_item/message` records. This table and ADAPTER_ATTRIBUTES must move
  // together — attribution is strictly downstream of seeing, and a test asserts the
  // relationship rather than relying on both being remembered.
  codex: ["tool_call", "slash_command"],
  gemini: ["tool_call"],
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
 * The primary shared tree: skill directories that per-agent roots symlink into. No
 * agent's system prompt reads it, so it is not an agent. A foreign installer owns its
 * `.skill-lock.json` manifest; peek reads this tree and does not write it.
 */
export function sharedLibraryRoot(env: HomeEnv = {}): string {
  return join(resolveHome(env).home, ".agents", "skills");
}

/**
 * Both shared trees. `~/.config/agents/skills` is a second, distinct tree — not a link to
 * the first — and several agents are rooted there rather than in `~/.agents/skills`.
 */
export function sharedLibraryRoots(env: HomeEnv = {}): string[] {
  const { home, config } = resolveHome(env);
  return [join(home, ".agents", "skills"), join(config, "agents", "skills")];
}

/**
 * peek's own knowledge, overlaid on the generated third-party table. An entry here wins,
 * so regenerating the table can never silently revert a correction, and every field it
 * sets is one peek has resolved on a real machine — hence `tier: "verified"`.
 *
 * Anything absent from this overlay ships as `sourced`.
 */
interface Overlay {
  slug: string;
  displayName?: string;
  adapter?: string;
  /** Extra roots beyond the generated one. Old paths stay as candidates: resolution
   * stats each, so a user mid-migration still resolves. */
  extraRoots?: SkillRoot[];
  projectDir?: string;
  honoursDisableModelInvocation?: boolean;
  /** Set when peek has actually resolved this agent's root on a machine. */
  verified?: boolean;
}

const OVERLAY: Overlay[] = [
  {
    slug: "claude-code",
    adapter: "claude-code",
    verified: true,
    honoursDisableModelInvocation: true,
    // `cache` only: the sibling `marketplaces/` holds catalogue checkouts of the same
    // plugins, which the agent never loads.
    extraRoots: [{ path: "{home}/.claude/plugins/cache", kind: "plugin", mutable: false }],
  },
  { slug: "codex", adapter: "codex", verified: true },
  { slug: "cursor", verified: true },
  { slug: "gemini-cli", adapter: "gemini", verified: true },
  { slug: "opencode", adapter: "opencode", verified: true },
  { slug: "goose", adapter: "goose", verified: true },
  { slug: "continue", verified: true },
  { slug: "droid", verified: true },
  // An adapter with no agent record contradicted the 0..n-roots model; the sourced table
  // supplies its root, so it is a real agent rather than an empty entry.
  { slug: "github-copilot", adapter: "copilot-cli" },
];

/** Resolves the generated table's {placeholder} bases against this machine. */
function expandRoot(template: string, env: HomeEnv): string {
  const { home, config } = resolveHome(env);
  const bases: Record<string, string> = {
    "{home}": home,
    "{config}": config,
    "{claude}": process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"),
    "{codex}": process.env.CODEX_HOME?.trim() || join(home, ".codex"),
    "{grok}": process.env.GROK_HOME?.trim() || join(home, ".grok"),
    "{vibe}": process.env.VIBE_HOME?.trim() || join(home, ".vibe"),
    "{hermes}": process.env.HERMES_HOME?.trim() || join(home, ".hermes"),
    "{autohand}": process.env.AUTOHAND_HOME?.trim() || join(home, ".autohand"),
  };
  const [, base, rest = ""] = template.match(/^(\{[a-z]+\})\/?(.*)$/) ?? [];
  const root = base ? bases[base] : undefined;
  if (!root) return template;
  return rest ? join(root, ...rest.split("/")) : root;
}

function agentFromGenerated(row: GeneratedAgent, overlay: Overlay | undefined, env: HomeEnv): Agent {
  const roots: SkillRoot[] = [];
  if (row.globalRoot) {
    const path = expandRoot(row.globalRoot, env);
    // amp, cline, dexto, kimi-code-cli, loaf, replit, warp and zed read the shared tree
    // directly. Their "installation" is the content every symlinking agent depends on, so
    // peek reports it and never offers to move it.
    const shared = sharedLibraryRoots(env).includes(path);
    roots.push({ path, kind: shared ? "shared" : "user", mutable: !shared });
  }
  for (const extra of overlay?.extraRoots ?? []) {
    roots.push({ ...extra, path: expandRoot(extra.path, env) });
  }
  return {
    slug: row.slug,
    displayName: overlay?.displayName ?? row.displayName,
    adapter: overlay?.adapter,
    roots,
    projectDir: overlay?.projectDir ?? row.projectDir,
    honoursDisableModelInvocation: overlay?.honoursDisableModelInvocation,
    tier: overlay?.verified ? "verified" : "sourced",
    detectPaths: row.detectPaths?.map((p) => expandRoot(p, env)),
  };
}

/** Provenance of the generated half of the table, for `peek agents --json` and doctor. */
export const AGENT_TABLE_SOURCE = GENERATED_SOURCE;

/**
 * Every agent peek ships knowledge of: the generated third-party table, with peek's
 * overlay applied. Roots are candidates — resolution stats them, and an absent root is
 * not an error, so shipping an unverified entry costs nothing and lets it self-verify.
 */
export function builtinAgents(env: HomeEnv = {}): Agent[] {
  const overlays = new Map(OVERLAY.map((o) => [o.slug, o]));
  const agents = GENERATED_AGENTS.map((row) => agentFromGenerated(row, overlays.get(row.slug), env));
  const known = new Set(agents.map((a) => a.slug));
  // An overlay for an agent the table does not carry still ships, with no root unless it
  // brings its own: the `no-convention` state.
  for (const overlay of OVERLAY) {
    if (known.has(overlay.slug)) continue;
    agents.push({
      slug: overlay.slug,
      displayName: overlay.displayName ?? overlay.slug,
      adapter: overlay.adapter,
      roots: (overlay.extraRoots ?? []).map((r) => ({ ...r, path: expandRoot(r.path, env) })),
      projectDir: overlay.projectDir,
      honoursDisableModelInvocation: overlay.honoursDisableModelInvocation,
      tier: overlay.verified ? "verified" : "sourced",
    });
  }
  return agents;
}
