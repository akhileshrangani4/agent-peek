// src/cli/skills-json.ts
//
// `peek skills --json` spread the whole inventory: every installation of every skill
// and every root scanned. On a machine with a thousand skills that was ~400k tokens,
// which no agent can read. The default is one record per skill; --details restores
// the rest.

export interface CompactSkillRecord {
  key: string;
  name: string;
  qualifiedName?: string;
  segment: string;
  reason: string;
  tokens: number;
  projectTokens?: number;
  agents: string[];
  installations: number;
  modelInvocable: boolean;
  flags: string[];
}

export function compactSkillsJson(full: Record<string, unknown>): Record<string, unknown> {
  const skills = (full.skills as Record<string, unknown>[] | undefined) ?? [];
  const compact: CompactSkillRecord[] = skills.map((skill) => {
    const installations = (skill.installations as { agent?: string }[] | undefined) ?? [];
    const agents = [...new Set(installations.map((i) => i.agent).filter((a): a is string => Boolean(a)))].sort();
    return {
      key: String(skill.key),
      name: String(skill.name),
      ...(skill.qualifiedName ? { qualifiedName: String(skill.qualifiedName) } : {}),
      segment: String(skill.segment ?? "unknown-usage"),
      reason: String(skill.reason ?? ""),
      tokens: Number(skill.chargedTokens ?? 0),
      ...(skill.projectTokens ? { projectTokens: Number(skill.projectTokens) } : {}),
      agents,
      installations: installations.length,
      modelInvocable: Boolean(skill.modelInvocable),
      flags: ((skill.flags as { kind?: string }[] | string[] | undefined) ?? []).map((f) => (typeof f === "string" ? f : String(f.kind ?? f))),
    };
  });
  const { rootsScanned, skills: _skills, ...rest } = full;
  return {
    ...rest,
    skills: compact,
    rootsScanned: Array.isArray(rootsScanned) ? rootsScanned.length : undefined,
    details: "run with --details for installations, flags with evidence, and roots scanned",
  };
}
