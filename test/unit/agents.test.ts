// test/unit/agents.test.ts
// The agent registry: builtin candidates resolved against disk, user entries that
// extend builtins, and the derived observable/manageable flags that the skills and
// usage surfaces key off. See CONTEXT.md for the vocabulary.
import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinAgents, adapterObserves, sharedLibraryRoot } from "../../src/agents/builtin.js";
import {
  addAgent, isPresent, listAgents, mergeAgents, readUserAgents, removeAgent, resolveAgent,
} from "../../src/agents/registry.js";
import type { Agent, ResolvedAgent } from "../../src/agents/types.js";

async function fixtureHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "peek-agents-"));
}

function bySlug(agents: ResolvedAgent[], slug: string): ResolvedAgent {
  const found = agents.find((a) => a.slug === slug);
  if (!found) throw new Error(`no agent ${slug}`);
  return found;
}

describe("builtin agent table", () => {
  it("declares agents with no adapter and adapters that belong to no agent", () => {
    const agents = builtinAgents({ home: "/home/x", xdgConfigHome: "/home/x/.config" });
    const slugs = agents.map((a) => a.slug);
    expect(slugs).toContain("cursor");
    expect(agents.find((a) => a.slug === "cursor")?.adapter).toBeUndefined();
    expect(slugs).not.toContain("tmux");
    expect(slugs).not.toContain("screen");
    expect(slugs).not.toContain("copilot-cli");
  });

  it("honours XDG_CONFIG_HOME for agents that live there, not a ~/.<agent> convention", () => {
    const agents = builtinAgents({ home: "/home/x", xdgConfigHome: "/cfg" });
    expect(bySlugRaw(agents, "opencode").roots[0]!.path).toBe("/cfg/opencode/skills");
    expect(bySlugRaw(agents, "goose").roots[0]!.path).toBe("/cfg/goose/skills");
    expect(bySlugRaw(agents, "codex").roots[0]!.path).toBe("/home/x/.codex/skills");
  });

  it("marks plugin roots immutable", () => {
    const claude = bySlugRaw(builtinAgents({ home: "/home/x" }), "claude-code");
    const plugin = claude.roots.find((r) => r.kind === "plugin");
    expect(plugin?.mutable).toBe(false);
    expect(claude.roots.find((r) => r.kind === "user")?.mutable).toBe(true);
  });

  it("keeps the shared library root out of the agent list", () => {
    const agents = builtinAgents({ home: "/home/x" });
    expect(agents.map((a) => a.slug)).not.toContain("agents");
    expect(sharedLibraryRoot({ home: "/home/x" })).toBe("/home/x/.agents/skills");
  });

  function bySlugRaw(agents: Agent[], slug: string): Agent {
    const found = agents.find((a) => a.slug === slug);
    if (!found) throw new Error(`no agent ${slug}`);
    return found;
  }
});

describe("adapter observability", () => {
  it("reports invocation kinds per adapter, not per product", () => {
    expect(adapterObserves("claude-code")).toEqual(["tool_call", "slash_command"]);
    expect(adapterObserves("codex")).toEqual(["tool_call"]);
  });

  it("returns no kinds for a missing or unknown adapter", () => {
    expect(adapterObserves(undefined)).toEqual([]);
    expect(adapterObserves("tmux")).toEqual([]);
    expect(adapterObserves("not-a-real-adapter")).toEqual([]);
  });
});

describe("resolveAgent", () => {
  it("marks roots present or absent and derives manageable from present mutable roots", async () => {
    const home = await fixtureHome();
    const realRoot = join(home, "real", "skills");
    await mkdir(realRoot, { recursive: true });
    const resolved = await resolveAgent({
      slug: "demo",
      displayName: "Demo",
      roots: [
        { path: realRoot, kind: "user", mutable: true },
        { path: join(home, "missing", "skills"), kind: "user", mutable: true },
      ],
    });
    expect(resolved.roots.map((r) => r.present)).toEqual([true, false]);
    expect(resolved.manageable).toBe(true);
  });

  it("is not manageable when the only present root is immutable", async () => {
    const home = await fixtureHome();
    const pluginRoot = join(home, "plugins");
    await mkdir(pluginRoot, { recursive: true });
    const resolved = await resolveAgent({
      slug: "demo",
      displayName: "Demo",
      roots: [{ path: pluginRoot, kind: "plugin", mutable: false }],
    });
    expect(resolved.manageable).toBe(false);
  });

  it("distinguishes three usage states: full, blind, and tool-calls-only", async () => {
    const base = { displayName: "x", roots: [] };
    const full = await resolveAgent({ ...base, slug: "claude-code", adapter: "claude-code" });
    const partial = await resolveAgent({ ...base, slug: "codex", adapter: "codex" });
    const blind = await resolveAgent({ ...base, slug: "cursor" });

    expect(full.observable).toBe(true);
    expect(full.observes).toContain("slash_command");

    // The state that would otherwise recommend archiving a slash-only skill.
    expect(partial.observable).toBe(true);
    expect(partial.observes).not.toContain("slash_command");

    expect(blind.observable).toBe(false);
    expect(blind.observes).toEqual([]);
  });

  it("never stores the derived flags on the input agent", async () => {
    const agent: Agent = { slug: "demo", displayName: "Demo", roots: [] };
    await resolveAgent(agent);
    expect(agent).not.toHaveProperty("observable");
    expect(agent).not.toHaveProperty("manageable");
  });
});

describe("mergeAgents", () => {
  it("adds an unknown slug as a user-defined agent", () => {
    const merged = mergeAgents(
      [{ slug: "codex", displayName: "Codex", roots: [] }],
      [{ slug: "amp", displayName: "Amp", roots: [{ path: "/a", kind: "user", mutable: true }] }],
    );
    expect(merged.map((a) => a.slug)).toEqual(["codex", "amp"]);
    expect(merged[1]!.userDefined).toBe(true);
  });

  it("extends a builtin of the same slug rather than replacing it", () => {
    const merged = mergeAgents(
      [{
        slug: "codex",
        displayName: "Codex",
        adapter: "codex",
        roots: [{ path: "/home/x/.codex/skills", kind: "user", mutable: true }],
      }],
      [{ slug: "codex", displayName: "Codex", roots: [{ path: "/extra", kind: "user", mutable: true }] }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.adapter).toBe("codex");
    expect(merged[0]!.roots.map((r) => r.path)).toEqual(["/home/x/.codex/skills", "/extra"]);
  });

  it("overrides a root of the same path and the adapter when given", () => {
    const merged = mergeAgents(
      [{ slug: "cursor", displayName: "Cursor", roots: [{ path: "/r", kind: "user", mutable: true }] }],
      [{ slug: "cursor", displayName: "Cursor", adapter: "cursor", roots: [{ path: "/r", kind: "user", mutable: false }] }],
    );
    expect(merged[0]!.roots).toHaveLength(1);
    expect(merged[0]!.roots[0]!.mutable).toBe(false);
    expect(merged[0]!.adapter).toBe("cursor");
  });

  it("does not mutate the builtin table it was handed", () => {
    const builtin: Agent[] = [{ slug: "codex", displayName: "Codex", roots: [] }];
    mergeAgents(builtin, [{ slug: "codex", displayName: "Codex", roots: [{ path: "/x", kind: "user", mutable: true }] }]);
    expect(builtin[0]!.roots).toEqual([]);
  });
});

describe("user entry file", () => {
  it("round-trips add, list, and remove without touching builtins", async () => {
    const stateDir = await fixtureHome();
    await addAgent({
      slug: "amp",
      displayName: "Amp",
      roots: [{ path: "/amp/skills", kind: "user", mutable: true }],
    }, { stateDir });

    expect((await readUserAgents({ stateDir })).map((a) => a.slug)).toEqual(["amp"]);
    const file = JSON.parse(await readFile(join(stateDir, "agents.json"), "utf8"));
    expect(file.version).toBe(1);

    expect(await removeAgent("amp", { stateDir })).toBe(true);
    expect(await readUserAgents({ stateDir })).toEqual([]);
    // A builtin has no user entry to remove, and is never deleted.
    expect(await removeAgent("codex", { stateDir })).toBe(false);
  });

  it("replaces an existing entry with the same slug instead of duplicating it", async () => {
    const stateDir = await fixtureHome();
    const entry: Agent = { slug: "amp", displayName: "Amp", roots: [{ path: "/one", kind: "user", mutable: true }] };
    await addAgent(entry, { stateDir });
    await addAgent({ ...entry, roots: [{ path: "/two", kind: "user", mutable: true }] }, { stateDir });
    const user = await readUserAgents({ stateDir });
    expect(user).toHaveLength(1);
    expect(user[0]!.roots[0]!.path).toBe("/two");
  });

  it("treats a missing or corrupt file as no user entries", async () => {
    const stateDir = await fixtureHome();
    expect(await readUserAgents({ stateDir })).toEqual([]);
    await writeFile(join(stateDir, "agents.json"), "{not json", "utf8");
    expect(await readUserAgents({ stateDir })).toEqual([]);
    await writeFile(join(stateDir, "agents.json"), JSON.stringify({ version: 1, agents: [{ nope: 1 }] }), "utf8");
    expect(await readUserAgents({ stateDir })).toEqual([]);
  });
});

describe("listAgents and presence", () => {
  it("resolves builtins against a fixture home and picks up user entries", async () => {
    const home = await fixtureHome();
    const stateDir = join(home, ".agent-peek");
    await mkdir(join(home, ".codex", "skills"), { recursive: true });
    await addAgent({
      slug: "amp",
      displayName: "Amp",
      roots: [{ path: join(home, "amp"), kind: "user", mutable: true }],
    }, { stateDir });

    const agents = await listAgents({ home, xdgConfigHome: join(home, ".config"), stateDir });
    expect(bySlug(agents, "codex").manageable).toBe(true);
    expect(bySlug(agents, "cursor").manageable).toBe(false);
    expect(bySlug(agents, "amp").observable).toBe(false);
  });

  it("hides an agent with no root on disk unless it has readable sessions", async () => {
    const home = await fixtureHome();
    await mkdir(join(home, ".codex", "skills"), { recursive: true });
    const agents = await listAgents({ home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek") });

    expect(isPresent(bySlug(agents, "codex"))).toBe(true);
    expect(isPresent(bySlug(agents, "cursor"))).toBe(false);
    // An installed agent with no skills yet is still real if peek can read its sessions.
    expect(isPresent(bySlug(agents, "gemini"), new Set(["gemini"]))).toBe(true);
  });
});
