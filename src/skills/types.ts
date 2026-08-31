// src/skills/types.ts
import type { SkillRootKind } from "../agents/types.js";

/**
 * A condition worth surfacing about a skill. Carried as data so the report (07) and the
 * MCP surface (08) render the same findings without re-deriving them.
 */
export type SkillFlag =
  | "duplicate-name"        // another skill answers to the same bare name
  | "no-description"        // no description frontmatter: nearly unpickable by a model
  | "immutable"             // every installation sits in a read-only root
  | "not-model-invocable"   // disable-model-invocation: only a human can reach it
  | "unreferenced";         // no agent peek has verified links to it

/** One agent's access to one skill. */
export interface SkillInstallation {
  /** Agent slug, or undefined for a shared tree scanned in its own right. */
  agent?: string;
  rootPath: string;
  rootKind: SkillRootKind;
  mutable: boolean;
  /** Path as it appears inside the root, before symlink resolution. */
  path: string;
  symlink: boolean;
  /** Version segment, for a plugin installation. The agent loads the newest only. */
  version?: string;
  /** Directory mtime, used to pick the current version when the segment is a hash. */
  mtimeMs?: number;
  /**
   * Tokens this installation is estimated to add to its agent's system prompt. Zero
   * when the agent honours `disable-model-invocation` and the skill sets it.
   */
  chargedTokens: number;
}

export interface Skill {
  /**
   * Stable identity. Realpath of the directory holding SKILL.md, except plugin skills,
   * which key on `plugin:<marketplace>/<plugin>/<name>` — their path carries a version,
   * so a realpath key would retire and re-create the skill on every upgrade.
   */
  key: string;
  /** Directory basename, and what an invocation usually spells. Not the identity. */
  name: string;
  /** `<plugin>:<name>` for a plugin skill: the other spelling an invocation may use. */
  qualifiedName?: string;
  description?: string;
  /** False when frontmatter sets disable-model-invocation: only a human can invoke it. */
  modelInvocable: boolean;
  /**
   * Estimated tokens for one agent that lists this skill: frontmatter name +
   * description. An upper bound — some hosts list a name without its description.
   */
  estimatedTokens: number;
  /** Sum of chargedTokens across installations. */
  chargedTokens: number;
  installations: SkillInstallation[];
  flags: SkillFlag[];
}

export interface Inventory {
  skills: Skill[];
  /** Roots walked, in order, including any that turned out to be absent. */
  rootsScanned: { path: string; agent?: string; kind: SkillRootKind; present: boolean }[];
  costBasis: string;
}

export type NameResolutionOutcome = "unique" | "ambiguous" | "not-a-skill" | "unmatched";

export interface NameResolution {
  /** The invocation name exactly as recorded. Never normalised in place. */
  name: string;
  outcome: NameResolutionOutcome;
  /** Keys of every skill answering to this name: one when unique, several when ambiguous. */
  keys: string[];
}
