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

  it("resolves a linked worktree to its main checkout, not to itself", async () => {
    // A worktree's .git is a file pointing at <main>/.git/worktrees/<name>. Stopping at
    // the first .git presents every worktree of one repo as a separate project: five
    // worktrees of buildy counted its skill root five times over.
    const main = await repo();
    const wt = await mkdtemp(join(tmpdir(), "peek-linked-"));
    await writeFile(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt1")}\n`, "utf8");
    expect(gitRootFor(wt)).toBe(main);
  });

  it("keeps a plain worktree-style .git file that names no worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "peek-plaingit-"));
    await writeFile(join(root, ".git"), "gitdir: /somewhere/else/.git\n", "utf8");
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

  it("collapses several worktrees of one repository to that repository", async () => {
    const main = await repo();
    const worktrees = await Promise.all([1, 2, 3].map(async (n) => {
      const wt = await mkdtemp(join(tmpdir(), `peek-wt${n}-`));
      await writeFile(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", `w${n}`)}\n`, "utf8");
      return wt;
    }));
    const out = projectRootsFromCwds([...worktrees, main]);
    expect(out.projects).toEqual([main]);
    expect(out.found).toBe(1);
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

describe("the shared tree is never a project", () => {
  it("is excluded by identity even when a recorded cwd is the home directory", async () => {
    // Ticket 02 Q3 removed "shared library root" from the agent model deliberately. A cwd
    // of $HOME would otherwise make $HOME/.agents/skills a project root for every agent
    // whose projectDir is `.agents/skills` — the same tree attributed eight times.
    const home = await mkdtemp(join(tmpdir(), "peek-shared-proj-"));
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await writeSkill(join(home, ".agents", "skills", "shared-one"), "shared-one");

    const inv = await buildInventory({
      home,
      xdgConfigHome: join(home, ".config"),
      stateDir: join(home, ".agent-peek"),
      projects: [home],
      projectDiscovery: { found: 1, capped: false },
    });

    const projectRoots = inv.rootsScanned.filter((r) => r.kind === "project");
    for (const root of projectRoots) {
      expect(root.path).not.toBe(join(home, ".agents", "skills"));
    }
    const shared = inv.skills.find((s) => s.name === "shared-one")!;
    expect(shared.installations.every((i) => i.rootKind !== "project")).toBe(true);
    // Scanned exactly once, not once per agent.
    expect(shared.installations).toHaveLength(1);
  });

  it("does not scan one path twice when a project root repeats an agent root", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-dupe-root-"));
    await writeSkill(join(home, ".claude", "skills", "only-once"), "only-once");
    const inv = await buildInventory({
      home,
      xdgConfigHome: join(home, ".config"),
      stateDir: join(home, ".agent-peek"),
      projects: [home],
      projectDiscovery: { found: 1, capped: false },
    });
    const paths = inv.rootsScanned.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(inv.skills.find((s) => s.name === "only-once")!.installations).toHaveLength(1);
  });
});

describe("only installed agents claim a project root", () => {
  it("ignores an uninstalled agent's project convention", async () => {
    // `openclaw` reads `<repo>/skills`. On a machine without it, that directory means
    // something else — peek's own repo ships a `skills/` package — and claiming it would
    // inventory a source tree as an install for an agent that is not here.
    const home = await mkdtemp(join(tmpdir(), "peek-uninstalled-"));
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    const project = await repo();
    await writeSkill(join(project, "skills", "shipped-package"), "shipped-package");
    await writeSkill(join(project, ".claude", "skills", "real-project-skill"), "real-project-skill");

    const inv = await buildInventory({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
      projects: [project], projectDiscovery: { found: 1, capped: false },
    });
    const names = inv.skills.map((s) => s.name);
    expect(names).toContain("real-project-skill");
    expect(names).not.toContain("shipped-package");
  });
});
