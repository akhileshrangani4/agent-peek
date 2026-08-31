// test/unit/skills.test.ts
// The skill inventory: what counts as a skill, how one is keyed, what it costs, and how
// a verbatim invocation name joins back to it. Every test runs against a fixture HOME;
// nothing here reads or writes a real skill root.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter, estimateListingTokens } from "../../src/skills/parse.js";
import { scanRoot } from "../../src/skills/scan.js";
import {
  buildInventory, pluginKeyFor, applyFlags, compareVersions, dedupeInstallations,
} from "../../src/skills/inventory.js";
import { buildNameIndex, resolveName, invocationName } from "../../src/skills/resolve.js";
import type { Inventory, Skill, SkillInstallation } from "../../src/skills/types.js";
import type { FoundSkill } from "../../src/skills/scan.js";

function skillMd(name: string, description?: string, extra = ""): string {
  const desc = description === undefined ? "" : `description: ${description}\n`;
  return `---\nname: ${name}\n${desc}${extra}---\n\n# ${name}\n\nBody text that is never charged for.\n`;
}

async function writeSkill(dir: string, name: string, description?: string, extra = ""): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), skillMd(name, description, extra), "utf8");
}

describe("frontmatter", () => {
  it("reads name, description, and the disable-model-invocation flag", () => {
    const fm = parseFrontmatter(skillMd("wayfinder", "Chart a map", "disable-model-invocation: true\n"));
    expect(fm.name).toBe("wayfinder");
    expect(fm.description).toBe("Chart a map");
    expect(fm.disableModelInvocation).toBe(true);
  });

  it("treats a file with no frontmatter as a skill nothing can describe", () => {
    const fm = parseFrontmatter("# just a heading\n");
    expect(fm.name).toBeUndefined();
    expect(fm.description).toBeUndefined();
    expect(fm.disableModelInvocation).toBe(false);
  });

  it("strips quotes and ignores a false flag", () => {
    const fm = parseFrontmatter('---\nname: "quoted"\ndisable-model-invocation: false\n---\n');
    expect(fm.name).toBe("quoted");
    expect(fm.disableModelInvocation).toBe(false);
  });

  it("costs the listing, not the file", () => {
    const short = parseFrontmatter(skillMd("a", "b"));
    // The body is long but only loaded on invocation, so it is not part of the estimate.
    expect(estimateListingTokens(short, "a")).toBe(estimateTokensOf("ab"));
  });

  function estimateTokensOf(s: string): number {
    return Math.ceil(s.length / 4);
  }
});

describe("scanRoot", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "peek-skills-scan-"));
    await writeSkill(join(root, "flat"), "flat", "a flat skill");
    // A bundle: one root entry holding many skills, as a checked-out repo does.
    await writeSkill(join(root, "bundle", "one"), "one", "first");
    await writeSkill(join(root, "bundle", "two"), "two", "second");
    // An empty directory is not a skill and not an error.
    await mkdir(join(root, "empty"), { recursive: true });
    // Nothing nested inside a skill is a second skill.
    await writeSkill(join(root, "outer"), "outer", "has a subdir");
    await writeSkill(join(root, "outer", "inner"), "inner", "should not be found");
  });

  it("finds a skill at any depth and treats a bundle as many skills", async () => {
    const found = await scanRoot({ path: root, kind: "user", mutable: true, maxDepth: 4 });
    expect(found.map((f) => f.name).sort()).toEqual(["flat", "one", "outer", "two"]);
  });

  it("stops descending once a SKILL.md is found", async () => {
    const found = await scanRoot({ path: root, kind: "user", mutable: true, maxDepth: 4 });
    expect(found.map((f) => f.name)).not.toContain("inner");
  });

  it("respects the depth bound", async () => {
    const found = await scanRoot({ path: root, kind: "user", mutable: true, maxDepth: 1 });
    expect(found.map((f) => f.name).sort()).toEqual(["flat", "outer"]);
  });

  it("returns nothing for a root that does not exist", async () => {
    const found = await scanRoot({ path: join(root, "nope"), kind: "user", mutable: true, maxDepth: 4 });
    expect(found).toEqual([]);
  });

  it("marks a symlinked installation and resolves it to its target", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-skills-link-"));
    const shared = join(home, "shared");
    const agentRoot = join(home, "agent");
    await writeSkill(join(shared, "linked"), "linked", "lives in the shared root");
    await mkdir(agentRoot, { recursive: true });
    await symlink(join(shared, "linked"), join(agentRoot, "linked"));

    const found = await scanRoot({ path: agentRoot, kind: "user", mutable: true, maxDepth: 4 });
    expect(found).toHaveLength(1);
    expect(found[0]!.symlink).toBe(true);
    expect(found[0]!.realDir).toContain("shared");
  });
});

describe("plugin identity", () => {
  const found = (relPath: string, name: string): FoundSkill => ({
    root: { path: "/plugins/cache", kind: "plugin", mutable: false, maxDepth: 8 },
    dir: `/plugins/cache/${relPath}`,
    realDir: `/plugins/cache/${relPath}`,
    relPath,
    name,
    symlink: false,
    mtimeMs: 0,
    text: "",
  });

  it("drops the version segment so an upgrade does not retire the skill", () => {
    const one = pluginKeyFor(found("mattpocock/mattpocock-skills/1.2.3/skills/engineering/wayfinder", "wayfinder"));
    const two = pluginKeyFor(found("mattpocock/mattpocock-skills/9.9.9/skills/engineering/wayfinder", "wayfinder"));
    expect(one?.key).toBe("plugin:mattpocock/mattpocock-skills/wayfinder");
    expect(two?.key).toBe(one?.key);
  });

  it("exposes the plugin-qualified spelling an invocation may use", () => {
    expect(pluginKeyFor(found("acme/tools/1.0.0/skills/build", "build"))?.qualifiedName).toBe("tools:build");
  });

  it("does not apply to a non-plugin root", () => {
    const nonPlugin = { ...found("x/y", "y"), root: { path: "/r", kind: "user" as const, mutable: true, maxDepth: 4 } };
    expect(pluginKeyFor(nonPlugin)).toBeUndefined();
  });
});

describe("buildInventory against a fixture HOME", () => {
  let home: string;
  let inventory: Inventory;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "peek-skills-home-"));
    const shared = join(home, ".agents", "skills");
    // One skill in the shared library root, symlinked into two agents.
    await writeSkill(join(shared, "shared-skill"), "shared-skill", "reached from two agents");
    // One that no agent links to.
    await writeSkill(join(shared, "orphan"), "orphan", "linked by nobody");
    // A slash-only skill, also shared.
    await writeSkill(join(shared, "slash-only"), "slash-only", "human only", "disable-model-invocation: true\n");

    for (const root of [join(home, ".claude", "skills"), join(home, ".codex", "skills")]) {
      await mkdir(root, { recursive: true });
      await symlink(join(shared, "shared-skill"), join(root, "shared-skill"));
      await symlink(join(shared, "slash-only"), join(root, "slash-only"));
    }
    // A real directory in one agent only, with no description.
    await writeSkill(join(home, ".claude", "skills", "local-only"), "local-only");
    // A plugin skill: reported, never mutated.
    await writeSkill(
      join(home, ".claude", "plugins", "cache", "acme", "toolkit", "1.0.0", "skills", "local-only"),
      "local-only", "a plugin skill sharing a bare name",
    );

    inventory = await buildInventory({
      home,
      xdgConfigHome: join(home, ".config"),
      stateDir: join(home, ".agent-peek"),
    });
  });

  function bySkillName(name: string): Skill[] {
    return inventory.skills.filter((s) => s.name === name);
  }

  it("counts one skill with many installations, not many skills", () => {
    const shared = bySkillName("shared-skill");
    expect(shared).toHaveLength(1);
    // claude-code, codex, and the shared library root itself.
    expect(shared[0]!.installations).toHaveLength(3);
    expect(shared[0]!.installations.filter((i) => i.agent).map((i) => i.agent).sort())
      .toEqual(["claude-code", "codex"]);
  });

  it("charges the listing once per agent that lists it, and not for the library root", () => {
    const shared = bySkillName("shared-skill")[0]!;
    const perAgent = shared.estimatedTokens;
    expect(shared.chargedTokens).toBe(perAgent * 2);
    expect(shared.installations.find((i) => !i.agent)!.chargedTokens).toBe(0);
  });

  it("charges nothing to an agent that honours disable-model-invocation, and charges one that may not", () => {
    const slashOnly = bySkillName("slash-only")[0]!;
    expect(slashOnly.modelInvocable).toBe(false);
    expect(slashOnly.flags).toContain("not-model-invocable");
    const claude = slashOnly.installations.find((i) => i.agent === "claude-code")!;
    const codex = slashOnly.installations.find((i) => i.agent === "codex")!;
    expect(claude.chargedTokens).toBe(0);
    // codex is not known to honour the flag, so the estimate stays an upper bound.
    expect(codex.chargedTokens).toBeGreaterThan(0);
  });

  it("flags a skill nothing links to and a skill with no description", () => {
    expect(bySkillName("orphan")[0]!.flags).toContain("unreferenced");
    const local = bySkillName("local-only").find((s) => !s.key.startsWith("plugin:"))!;
    expect(local.flags).toContain("no-description");
  });

  it("keeps two same-named skills of different origin apart and flags the collision", () => {
    const both = bySkillName("local-only");
    expect(both).toHaveLength(2);
    for (const skill of both) expect(skill.flags).toContain("duplicate-name");
    const plugin = both.find((s) => s.key.startsWith("plugin:"))!;
    expect(plugin.flags).toContain("immutable");
    expect(plugin.key).toBe("plugin:acme/toolkit/local-only");
  });

  it("states the basis of its cost estimate rather than claiming a measurement", () => {
    expect(inventory.costBasis).toMatch(/upper bound/i);
  });
});

describe("name resolution", () => {
  const skill = (key: string, name: string, qualifiedName?: string): Skill => ({
    key, name, qualifiedName, modelInvocable: true, estimatedTokens: 10, chargedTokens: 10,
    installations: [], flags: [],
  });
  const inventory: Inventory = {
    skills: [
      skill("plugin:mp/mattpocock-skills/wayfinder", "wayfinder", "mattpocock-skills:wayfinder"),
      skill("/home/x/.agents/skills/ai-sdk", "ai-sdk"),
      skill("plugin:v/vercel/ai-sdk", "ai-sdk", "vercel:ai-sdk"),
    ],
    rootsScanned: [],
    costBasis: "",
  };
  const index = buildNameIndex(inventory);

  it("resolves the bare, prefixed, and slash spellings of one skill to that skill", () => {
    for (const spelling of ["wayfinder", "/wayfinder", "mattpocock-skills:wayfinder", "/mattpocock-skills:wayfinder"]) {
      const r = resolveName(index, spelling);
      expect(r.outcome).toBe("unique");
      expect(r.keys).toEqual(["plugin:mp/mattpocock-skills/wayfinder"]);
      // The recorded name is echoed verbatim, never rewritten.
      expect(r.name).toBe(spelling);
    }
  });

  it("reports a shared bare name as ambiguous rather than merging or dropping it", () => {
    const r = resolveName(index, "ai-sdk");
    expect(r.outcome).toBe("ambiguous");
    expect(r.keys).toHaveLength(2);
    // The prefixed spelling disambiguates.
    expect(resolveName(index, "vercel:ai-sdk").outcome).toBe("unique");
  });

  it("classifies a CLI built-in as not-a-skill, not an unknown skill", () => {
    for (const builtin of ["/login", "/clear", "/model", "/mcp", "/resume"]) {
      expect(resolveName(index, builtin).outcome).toBe("not-a-skill");
    }
    // Only as a slash command: a Skill-tool call named "clear" would be a real skill.
    expect(resolveName(index, "clear").outcome).toBe("unmatched");
  });

  it("reports a name matching nothing as unmatched", () => {
    expect(resolveName(index, "/nope").outcome).toBe("unmatched");
    expect(invocationName("/nope")).toBe("nope");
  });
});

describe("applyFlags", () => {
  it("flags a skill whose installations are all read-only", () => {
    const skills: Skill[] = [{
      key: "k", name: "n", modelInvocable: true, estimatedTokens: 1, chargedTokens: 1, flags: [],
      description: "d",
      installations: [{ agent: "claude-code", rootPath: "/p", rootKind: "plugin", mutable: false, path: "/p/n", symlink: false, chargedTokens: 1 }],
    }];
    applyFlags(skills);
    expect(skills[0]!.flags).toEqual(["immutable"]);
  });
});

describe("plugin version dedupe", () => {
  const install = (version: string, mtimeMs = 0): SkillInstallation => ({
    agent: "claude-code", rootPath: "/cache", rootKind: "plugin", mutable: false,
    path: `/cache/p/${version}`, symlink: false, version, mtimeMs, chargedTokens: 10,
  });

  it("orders dotted versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
  });

  it("refuses to order names that are not versions", () => {
    // Real cache directories include content hashes and the literal "unknown".
    expect(compareVersions("ed404106fcd8", "unknown")).toBe(0);
    expect(compareVersions("1.0.0", "unknown")).toBe(0);
  });

  it("keeps one installation per agent and root, preferring the higher version", () => {
    const kept = dedupeInstallations([install("1.1.57"), install("1.1.58")]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.version).toBe("1.1.58");
  });

  it("falls back to mtime when the version segments cannot be ordered", () => {
    const kept = dedupeInstallations([install("unknown", 100), install("ed404106fcd8", 500)]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.version).toBe("ed404106fcd8");
  });

  it("leaves non-plugin installations alone", () => {
    const plain: SkillInstallation = {
      agent: "codex", rootPath: "/r", rootKind: "user", mutable: true, path: "/r/a",
      symlink: false, chargedTokens: 5,
    };
    expect(dedupeInstallations([plain, plain])).toHaveLength(2);
  });

  it("charges a multi-version plugin skill once per agent, end to end", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-skills-versions-"));
    const cache = join(home, ".claude", "plugins", "cache", "acme", "toolkit");
    await writeSkill(join(cache, "1.0.0", "skills", "tool"), "tool", "a plugin skill");
    await writeSkill(join(cache, "1.1.0", "skills", "tool"), "tool", "a plugin skill");
    const inv = await buildInventory({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
    });
    const tool = inv.skills.filter((s) => s.name === "tool");
    expect(tool).toHaveLength(1);
    // The agent loads one version; charging both would overstate cost by 100%.
    expect(tool[0]!.installations).toHaveLength(1);
    expect(tool[0]!.installations[0]!.version).toBe("1.1.0");
    expect(tool[0]!.chargedTokens).toBe(tool[0]!.estimatedTokens);
  });
});

describe("project-local roots", () => {
  it("inventories a project root as read-only and never mutable", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-skills-proj-home-"));
    const project = await mkdtemp(join(tmpdir(), "peek-skills-proj-"));
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await writeSkill(join(project, ".claude", "skills", "repo-skill"), "repo-skill", "lives in the repo");

    const inv = await buildInventory({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
      projects: [project],
    });
    const repo = inv.skills.find((s) => s.name === "repo-skill");
    expect(repo).toBeDefined();
    const install = repo!.installations[0]!;
    expect(install.rootKind).toBe("project");
    expect(install.agent).toBe("claude-code");
    // A repo file belongs to git and its collaborators, not to peek.
    expect(install.mutable).toBe(false);
    expect(repo!.flags).toContain("immutable");
  });

  it("ignores a project directory with no skill root", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-skills-proj2-"));
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    const inv = await buildInventory({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
      projects: [await mkdtemp(join(tmpdir(), "peek-empty-project-"))],
    });
    expect(inv.rootsScanned.every((r) => r.kind !== "project")).toBe(true);
  });
});
