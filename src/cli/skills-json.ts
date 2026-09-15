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

export interface CompactOptions {
  /** Every skill, not just the top rows per segment. */
  all?: boolean;
  /** Rows per segment when not --all. Defaults match the printed report: 20 archivable, 8 elsewhere. */
  limit?: number;
}

export function compactSkillsJson(full: Record<string, unknown>, opts: CompactOptions = {}): Record<string, unknown> {
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
  // A thousand compact records is still half a megabyte. Default to what the printed
  // report shows: the top rows of each segment, by tokens, with the count of the rest.
  let shown = compact;
  let omitted = 0;
  if (!opts.all) {
    const perSegment = new Map<string, CompactSkillRecord[]>();
    for (const record of [...compact].sort((a, b) => b.tokens - a.tokens)) {
      const list = perSegment.get(record.segment) ?? [];
      list.push(record);
      perSegment.set(record.segment, list);
    }
    shown = [];
    for (const [segment, list] of perSegment) {
      const limit = opts.limit ?? (segment === "archivable" ? 20 : 8);
      shown.push(...list.slice(0, limit));
      omitted += Math.max(0, list.length - limit);
    }
  }
  const { rootsScanned, skills: _skills, ...rest } = full;
  return {
    ...rest,
    totalSkills: compact.length,
    skills: shown,
    ...(omitted ? { omittedSkills: omitted, more: "run with --all for every skill, or --limit <n> for more rows per segment" } : {}),
    rootsScanned: Array.isArray(rootsScanned) ? rootsScanned.length : undefined,
    details: "run with --details for installations, flags with evidence, and roots scanned",
  };
}
