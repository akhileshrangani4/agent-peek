// test/unit/skills-projects.test.ts
//
// Project-local skill roots (ticket 14). Fixtures under mkdtemp only: this ticket walks
// directories peek had not touched before, so nothing here reads a real project tree.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitRootFor, projectRootsFromCwds, PROJECT_SCAN_LIMIT } from "../../src/skills/projects.js";
import { scanRoot } from "../../src/skills/scan.js";
import { buildInventory } from "../../src/skills/inventory.js";

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n\nbody\n`, "utf8");
}

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "peek-project-"));
  await mkdir(join(root, ".git"), { recursive: true });
  return root;
}

describe("gitRootFor", () => {
  it("finds the repository a working directory sits in", async () => {
    const root = await repo();
    const deep = join(root, "packages", "app", "src");
    await mkdir(deep, { recursive: true });
    expect(gitRootFor(deep)).toBe(root);
  });

  it("treats a worktree's .git file as a root, not only a directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "peek-worktree-"));
    await writeFile(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n", "utf8");
    expect(gitRootFor(root)).toBe(root);
  });

  it("returns undefined outside any repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "peek-plain-"));
    expect(gitRootFor(plain)).toBeUndefined();
  });
});

describe("projectRootsFromCwds", () => {
  it("collapses subdirectories of one repo to a single project", async () => {
    const root = await repo();
    await mkdir(join(root, "a", "b"), { recursive: true });
    const out = projectRootsFromCwds([join(root, "a", "b"), join(root, "a"), root]);
    // 133 of 143 recorded cwds are subdirectory or worktree paths; without this they
    // would present as 133 separate projects.
    expect(out.projects).toEqual([root]);
    expect(out.found).toBe(1);
  });

  it("keeps a directory that belongs to no repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "peek-plain-"));
    expect(projectRootsFromCwds([plain]).projects).toEqual([plain]);
  });

  it("preserves order and reports when the cap bites", async () => {
    const roots = await Promise.all(Array.from({ length: 4 }, () => repo()));
    const out = projectRootsFromCwds(roots, 2);
    expect(out.projects).toEqual(roots.slice(0, 2));
    expect(out.found).toBe(4);
    expect(out.capped).toBe(true);
    expect(projectRootsFromCwds(roots, PROJECT_SCAN_LIMIT).capped).toBe(false);
  });

  it("ignores empty entries", () => {
    expect(projectRootsFromCwds(["", ""]).projects).toEqual([]);
  });
});

describe("walking a project tree", () => {
  it("never inventories a skill inside node_modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "peek-vendor-"));
    await writeSkill(join(root, "mine"), "mine");
    // A SKILL.md shipped by a dependency belongs to that package: the user installed the
    // package, they did not choose the skill.
    await writeSkill(join(root, "node_modules", "some-pkg", "skills", "theirs"), "theirs");
    await writeSkill(join(root, "dist", "built"), "built");
    const found = await scanRoot({ path: root, kind: "project", mutable: false, maxDepth: 4 });
    expect(found.map((f) => f.name)).toEqual(["mine"]);
  });

  it("does not follow a symlink out of a project root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "peek-outside-"));
    await writeSkill(join(outside, "elsewhere"), "elsewhere");
    const root = await mkdtemp(join(tmpdir(), "peek-escape-"));
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "link"));
    const found = await scanRoot({ path: root, kind: "project", mutable: false, maxDepth: 4 });
    expect(found).toEqual([]);
  });

  it("still follows a link that stays inside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "peek-inside-"));
    await writeSkill(join(root, "src", "real"), "real");
    await mkdir(join(root, "linked"), { recursive: true });
    await symlink(join(root, "src", "real"), join(root, "linked", "real"));
    const found = await scanRoot({ path: root, kind: "project", mutable: false, maxDepth: 4 });
    expect(found.length).toBeGreaterThanOrEqual(1);
  });
});

describe("project installations in the inventory", () => {
  it("is reported, never mutable, and kept out of the machine-wide cost", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-project-home-"));
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await writeSkill(join(home, ".claude", "skills", "global-skill"), "global-skill");
    const project = await repo();
    await writeSkill(join(project, ".claude", "skills", "repo-skill"), "repo-skill");

    const inv = await buildInventory({
      home,
      xdgConfigHome: join(home, ".config"),
      stateDir: join(home, ".agent-peek"),
      projects: [project],
      projectDiscovery: { found: 1, capped: false },
    });

    const repoSkill = inv.skills.find((s) => s.name === "repo-skill")!;
    expect(repoSkill.installations[0]!.rootKind).toBe("project");
    // A repo file belongs to git and its collaborators, not to peek (ticket 04 Q5).
    expect(repoSkill.installations[0]!.mutable).toBe(false);
    expect(repoSkill.flags).toContain("immutable");

    // Charged separately: a project skill is paid for only while working in that repo.
    expect(repoSkill.chargedTokens).toBe(0);
    expect(repoSkill.projectTokens).toBeGreaterThan(0);
    const global = inv.skills.find((s) => s.name === "global-skill")!;
    expect(global.chargedTokens).toBeGreaterThan(0);

    expect(inv.projects).toMatchObject({ found: 1, capped: false, skills: 1 });
    expect(inv.projects!.tokens).toBe(repoSkill.projectTokens);
  });

  it("reports no project block when no project was surveyed", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-noproj-"));
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    const inv = await buildInventory({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
    });
    expect(inv.projects).toBeUndefined();
  });
});
