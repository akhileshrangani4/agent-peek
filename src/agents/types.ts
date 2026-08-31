// src/agents/types.ts

/**
 * How a skill invocation was expressed. See CONTEXT.md: an invocation is not a tool
 * call. A skill carrying `disable-model-invocation` can only ever be slash-invoked, so
 * an index that sees only tool calls reports it as never used.
 */
export type InvocationKind = "tool_call" | "slash_command";

/** Where a skill root sits in an agent's install layout. */
export type SkillRootKind = "user" | "plugin" | "project";

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
  /** At least one present, mutable root — skills here may be archived. */
  manageable: boolean;
}
