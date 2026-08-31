// src/skills/parse.ts
import { estimateTokens } from "../feed/schema.js";

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  /** Claude Code convention: the skill is not listed to the model, only slash-invoked. */
  disableModelInvocation: boolean;
}

const FRONTMATTER_LIMIT = 8192;

/** Reads the leading `---` block. Deliberately tolerant: a skill with no frontmatter
 * is still a skill, it is just one nothing can describe. */
export function parseFrontmatter(text: string): SkillFrontmatter {
  const head = text.slice(0, FRONTMATTER_LIMIT);
  if (!head.startsWith("---")) return { disableModelInvocation: false };
  const end = head.indexOf("\n---", 3);
  const block = end === -1 ? head.slice(3) : head.slice(3, end);
  return {
    name: scalar(block, "name"),
    description: scalar(block, "description"),
    disableModelInvocation: /^disable-model-invocation:\s*true\s*$/m.test(block),
  };
}

function scalar(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  if (!match) return undefined;
  const value = match[1]!.trim().replace(/^["']|["']$/g, "");
  return value.length ? value : undefined;
}

/**
 * What an agent's system prompt pays per turn to list this skill: name plus
 * description. Not the size of SKILL.md — the body is only read on invocation.
 */
export function estimateListingTokens(fm: SkillFrontmatter, fallbackName: string): number {
  return estimateTokens(`${fm.name ?? fallbackName}${fm.description ?? ""}`);
}
