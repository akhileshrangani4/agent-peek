// src/agents/types.ts

/**
 * How a skill invocation was expressed. See CONTEXT.md: an invocation is not a tool
 * call. A skill carrying `disable-model-invocation` can only ever be slash-invoked, so
 * an index that sees only tool calls reports it as never used.
 */
export type InvocationKind = "tool_call" | "slash_command";

/**
 * How much peek actually knows about an entry:
 * - `verified`: peek has resolved this agent's root on a machine that had the agent.
 * - `sourced`: taken from a named third-party table or official docs, never confirmed by
 *   peek. A sourced entry self-verifies on a user's machine by resolving, or not.
 */
export type AgentTier = "verified" | "sourced";

/** One row of the generated third-party table, before peek's overlay is applied. */
export interface GeneratedAgent {
  slug: string;
  displayName: string;
  /** Path, relative to a project, this agent reads skills from. */
  projectDir: string;
  /** Global root with {home}/{config}/... placeholders, or absent when unresolvable. */
  globalRoot?: string;
  /**
   * Paths whose existence proves the agent itself is installed. Needed because several
   * agents' skill root is the shared tree, whose existence says nothing about them.
   */
  detectPaths?: string[];
}

/**
 * Where a skill root sits in an agent's install layout. `shared` is the library tree
 * (`~/.agents/skills`): several agents read it *directly* rather than symlinking into it,
 * so it can appear as an agent's own root — but its contents back every other agent's
 * links, which is why it is never mutable.
 */
export type SkillRootKind = "user" | "plugin" | "project" | "shared";

export interface SkillRoot {
  /** Candidate absolute path. Resolved against disk; may not exist. */
  path: string;
  kind: SkillRootKind;
  /** False for roots peek reports but never mutates (plugin roots). */
  mutable: boolean;
}

/**
 * A coding agent product installed on this machine. Agents and adapters are
 * orthogonal: an agent may have no adapter (cursor, continue, factory) and an adapter
 * may belong to no agent (screen, tmux, copilot-cli).
 */
export interface Agent {
  /** Product slug, e.g. "claude-code". Not the root dir, not necessarily the adapter. */
  slug: string;
  displayName: string;
  /** Reference to an adapter name, when peek can read this agent's transcripts. */
  adapter?: string;
  roots: SkillRoot[];
  /**
   * Path, relative to a project directory, where this agent reads project-local skills
   * (e.g. ".claude/skills"). Undefined when the agent has no project-local convention.
   */
  projectDir?: string;
  /**
   * True when this agent is known to honour `disable-model-invocation` frontmatter, and
   * therefore does not pay listing tokens for such a skill. Verified for Claude Code;
   * unknown elsewhere, so cost stays an upper bound rather than a false zero.
   */
  honoursDisableModelInvocation?: boolean;
  /** How much peek knows about this entry. Absent on a user-registered agent. */
  tier?: AgentTier;
  /** Paths proving this agent is installed, independent of any shared skill root. */
  detectPaths?: string[];
  /** True when the entry came from ~/.agent-peek/agents.json rather than the builtin table. */
  userDefined?: boolean;
}

export interface ResolvedSkillRoot extends SkillRoot {
  present: boolean;
}

/**
 * An agent with its roots checked against disk and its capabilities derived. Never
 * store `observable` or `manageable`: they go stale the moment a user adds a root.
 */
export interface ResolvedAgent extends Omit<Agent, "roots"> {
  roots: ResolvedSkillRoot[];
  /** Invocation kinds this agent's adapter can extract. Empty when it has no adapter. */
  observes: InvocationKind[];
  /** observes.length > 0 — usage is knowable at all. */
  observable: boolean;
  /**
   * Invocation kinds peek can attribute **to a named skill**, which is a strictly
   * stronger capability than observing them. Codex is the case that forces the
   * distinction: peek indexes 8,237 codex invocations and can name a skill in zero of
   * them, because a codex skill invocation is an `exec` like any other. Seeing a tool
   * call is not the same as knowing which skill it was.
   *
   * This describes what the **shipped extractor** attributes, not what the agent
   * records. Codex transcripts do carry slash commands, but until an extractor reads
   * them this must stay empty: claiming attribution peek does not have turns "peek
   * cannot see this" into "you never used this", which is the destructive direction.
   */
  attributes: InvocationKind[];
  /** attributes.length > 0 — a zero count for this agent means something. */
  attributable: boolean;
  /** At least one present, mutable root — skills here may be archived. */
  manageable: boolean;
  /** True when one of the agent's own directories exists on this machine. */
  installed: boolean;
  /**
   * - `present`: evidence the product itself is here — a directory of its own holding
   *   something besides a skills root.
   * - `unconfirmed`: a skill root exists, but nothing else does. The skills installer
   *   creates those directories itself, so their existence is evidence about the
   *   installer, not about the agent. peek says so rather than resolving the ambiguity.
   * - `absent`: peek knows the convention, nothing is here.
   * - `no-convention`: peek knows the agent exists but has no root path for it.
   */
  presence: "present" | "unconfirmed" | "absent" | "no-convention";
}
