// test/unit/skills-archive.test.ts
// Archive and restore. Every test builds its own fixture tree under mkdtemp; nothing
// here reads, writes, moves, or unlinks anything under a real skill root.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, readlink, lstat, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildInventory } from "../../src/skills/inventory.js";
import {
  planArchive, executeArchive, executeRestore, readArchiveLog, findArchive, selectSkill,
  manifestDivergence, ArchiveRefusedError,
} from "../../src/skills/archive.js";
import type { Inventory } from "../../src/skills/types.js";

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: a fixture skill\n---\n\nbody\n`, "utf8");
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}

/**
 * A fixture HOME shaped like the real machine: a shared library root holding content,
 * agent roots holding symlinks into it, and one agent-local real directory.
 */
async function fixture(): Promise<{ home: string; stateDir: string; inventory: Inventory }> {
  const home = await mkdtemp(join(tmpdir(), "peek-archive-"));
  const shared = join(home, ".agents", "skills");
  await writeSkill(join(shared, "shared-skill"), "shared-skill");
  for (const [root, agent] of [
    [join(home, ".claude", "skills"), "claude-code"],
    [join(home, ".codex", "skills"), "codex"],
    [join(home, ".config", "goose", "skills"), "goose"],
  ] as const) {
    void agent;
    await mkdir(root, { recursive: true });
    await symlink(join(shared, "shared-skill"), join(root, "shared-skill"));
  }
  await writeSkill(join(home, ".claude", "skills", "local-only"), "local-only");
  const stateDir = join(home, ".agent-peek");
  const inventory = await buildInventory({ home, xdgConfigHome: join(home, ".config"), stateDir });
  return { home, stateDir, inventory };
}

describe("planArchive", () => {
  it("derives unlink for a symlinked installation and move for a real directory", async () => {
    const { inventory } = await fixture();
    const shared = planArchive(inventory, "shared-skill", { agent: "codex" });
    expect(shared.actions).toHaveLength(1);
    expect(shared.actions[0]!.kind).toBe("unlink");

    const local = planArchive(inventory, "local-only");
    expect(local.actions[0]!.kind).toBe("move");
  });

  it("refuses to guess the scope when a skill is installed for several agents", async () => {
    const { inventory } = await fixture();
    expect(() => planArchive(inventory, "shared-skill")).toThrowError(ArchiveRefusedError);
    try {
      planArchive(inventory, "shared-skill");
    } catch (e) {
      expect((e as ArchiveRefusedError).reason).toBe("scope_required");
      // The refusal names the installations so the user can choose.
      expect((e as ArchiveRefusedError).detail).toHaveLength(3);
    }
  });

  it("plans every agent when --all-agents is given", async () => {
    const { inventory } = await fixture();
    const plan = planArchive(inventory, "shared-skill", { allAgents: true });
    expect(plan.actions).toHaveLength(3);
    expect(plan.actions.every((a) => a.kind === "unlink")).toBe(true);
  });

  it("skips the shared library root rather than removing the content behind everyone's links", async () => {
    const { inventory } = await fixture();
    const plan = planArchive(inventory, "shared-skill", { allAgents: true });
    expect(plan.skipped.some((s) => s.reason.includes("shared library root"))).toBe(true);
  });

  it("refuses an immutable installation", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-archive-plugin-"));
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await writeSkill(
      join(home, ".claude", "plugins", "cache", "acme", "kit", "1.0.0", "skills", "plug"), "plug",
    );
    const inventory = await buildInventory({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
    });
    expect(() => planArchive(inventory, "plug")).toThrowError(/no installation peek may modify/);
  });

  it("refuses a name that several skills answer to, and accepts the key instead", async () => {
    const { inventory } = await fixture();
    const clash = { ...inventory.skills[0]!, key: "other-key" };
    const twoSkills: Inventory = { ...inventory, skills: [...inventory.skills, clash] };
    expect(() => selectSkill(twoSkills, clash.name)).toThrowError(/names 2 skills/);
    expect(selectSkill(twoSkills, "other-key").key).toBe("other-key");
  });

  it("refuses when the named agent has no installation", async () => {
    const { inventory } = await fixture();
    expect(() => planArchive(inventory, "local-only", { agent: "codex" }))
      .toThrowError(/no mutable installation for codex/);
  });
});

describe("executeArchive", () => {
  it("unlinking one agent leaves the other agents and the shared content untouched", async () => {
    // The regression this whole module exists to prevent.
    const { home, stateDir, inventory } = await fixture();
    const plan = planArchive(inventory, "shared-skill", { agent: "codex" });
    await executeArchive(plan, { stateDir });

    const shared = join(home, ".agents", "skills", "shared-skill", "SKILL.md");
    expect(await exists(shared)).toBe(true);
    expect(await exists(join(home, ".codex", "skills", "shared-skill"))).toBe(false);
    for (const other of [
      join(home, ".claude", "skills", "shared-skill"),
      join(home, ".config", "goose", "skills", "shared-skill"),
    ]) {
      expect(await exists(other)).toBe(true);
      // Still a working link to the shared content, not a dangling one.
      expect(await readlink(other)).toBe(join(home, ".agents", "skills", "shared-skill"));
      expect(await exists(join(other, "SKILL.md"))).toBe(true);
    }
  });

  it("moves a real directory into peek's own archive, not into an agent's tree", async () => {
    const { home, stateDir, inventory } = await fixture();
    const plan = planArchive(inventory, "local-only");
    const record = await executeArchive(plan, { stateDir });

    expect(await exists(join(home, ".claude", "skills", "local-only"))).toBe(false);
    expect(record.actions[0]!.destination!.startsWith(join(stateDir, "archive"))).toBe(true);
    expect(await exists(join(record.actions[0]!.destination!, "SKILL.md"))).toBe(true);
  });

  it("refuses to move a path that is a symlink", async () => {
    // Moving a link's target relocates shared content and breaks every other agent.
    const { home, stateDir, inventory } = await fixture();
    const plan = planArchive(inventory, "shared-skill", { agent: "codex" });
    const forced = { ...plan, actions: plan.actions.map((a) => ({ ...a, kind: "move" as const })) };
    await expect(executeArchive(forced, { stateDir })).rejects.toThrowError(/would relocate shared content/);
    // And nothing moved.
    expect(await exists(join(home, ".codex", "skills", "shared-skill"))).toBe(true);
    expect(await exists(join(home, ".agents", "skills", "shared-skill", "SKILL.md"))).toBe(true);
  });

  it("refuses to unlink a path that turns out to be a real directory", async () => {
    const { stateDir, inventory } = await fixture();
    const plan = planArchive(inventory, "local-only");
    const forced = { ...plan, actions: plan.actions.map((a) => ({ ...a, kind: "unlink" as const })) };
    await expect(executeArchive(forced, { stateDir })).rejects.toThrowError(/must be moved, not unlinked/);
  });

  it("records the actions it completed when a later one refuses, so they stay restorable", async () => {
    // Execution re-checks the filesystem, so a mid-plan refusal is expected. What must
    // never happen is earlier unlinks landing with no record and no way back.
    const { home, stateDir, inventory } = await fixture();
    const plan = planArchive(inventory, "shared-skill", { allAgents: true });
    expect(plan.actions).toHaveLength(3);
    // Something replaces the last target with a real directory after planning.
    const last = plan.actions[2]!;
    await unlink(last.path);
    await writeSkill(last.path, "shared-skill");

    await expect(executeArchive(plan, { stateDir })).rejects.toThrowError(/must be moved, not unlinked/);

    const log = await readArchiveLog({ stateDir });
    expect(log).toHaveLength(1);
    expect(log[0]!.partial).toBe(true);
    expect(log[0]!.actions).toHaveLength(2);
    expect(await exists(plan.actions[0]!.path)).toBe(false);

    // And the partial record restores the two links that were removed.
    await executeRestore(log[0]!, { stateDir });
    expect(await readlink(plan.actions[0]!.path)).toBe(join(home, ".agents", "skills", "shared-skill"));
    expect(await readlink(plan.actions[1]!.path)).toBe(join(home, ".agents", "skills", "shared-skill"));
  });

  it("records what it did so a restore can replay it", async () => {
    const { stateDir, inventory } = await fixture();
    await executeArchive(planArchive(inventory, "local-only"), { stateDir });
    const log = await readArchiveLog({ stateDir });
    expect(log).toHaveLength(1);
    expect(log[0]!.skillName).toBe("local-only");
    expect(findArchive(log, "local-only").id).toBe(log[0]!.id);
  });
});

describe("executeRestore", () => {
  it("puts a moved directory back where it came from", async () => {
    const { home, stateDir, inventory } = await fixture();
    const record = await executeArchive(planArchive(inventory, "local-only"), { stateDir });
    await executeRestore(record, { stateDir });

    const back = join(home, ".claude", "skills", "local-only", "SKILL.md");
    expect(await exists(back)).toBe(true);
    expect(await readFile(back, "utf8")).toContain("local-only");
    expect(await readArchiveLog({ stateDir })).toEqual([]);
  });

  it("recreates a link with its original target", async () => {
    const { home, stateDir, inventory } = await fixture();
    const record = await executeArchive(
      planArchive(inventory, "shared-skill", { agent: "codex" }), { stateDir },
    );
    await executeRestore(record, { stateDir });
    const link = join(home, ".codex", "skills", "shared-skill");
    expect(await readlink(link)).toBe(join(home, ".agents", "skills", "shared-skill"));
  });

  it("refuses to overwrite a path that exists again", async () => {
    const { home, stateDir, inventory } = await fixture();
    const record = await executeArchive(planArchive(inventory, "local-only"), { stateDir });
    await writeSkill(join(home, ".claude", "skills", "local-only"), "a different skill now");
    await expect(executeRestore(record, { stateDir })).rejects.toThrowError(/refusing to overwrite/);
  });

  it("refuses when nothing was archived under that name", async () => {
    expect(() => findArchive([], "never-archived")).toThrowError(/Nothing archived/);
  });
});

describe("foreign manifest", () => {
  it("reports divergence in both directions and writes nothing", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-manifest-"));
    const shared = join(home, ".agents", "skills");
    await writeSkill(join(shared, "on-disk-and-listed"), "a");
    await writeSkill(join(shared, "on-disk-only"), "b");
    const manifestPath = join(home, ".agents", ".skill-lock.json");
    const before = JSON.stringify({
      version: 3,
      skills: { "on-disk-and-listed": { source: "x" }, "listed-only": { source: "y" } },
    });
    await writeFile(manifestPath, before, "utf8");

    const divergence = (await manifestDivergence(shared))!;
    expect(divergence.listedAndPresent).toEqual(["on-disk-and-listed"]);
    expect(divergence.listedButMissing).toEqual(["listed-only"]);
    expect(divergence.presentButUnlisted).toEqual(["on-disk-only"]);
    // The manifest belongs to a foreign installer: peek reads it and never writes it.
    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });

  it("is undefined when there is no manifest", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-manifest-none-"));
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    expect(await manifestDivergence(join(home, ".agents", "skills"))).toBeUndefined();
  });
});
