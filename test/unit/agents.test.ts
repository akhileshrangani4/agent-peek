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

  it("ships far more agents than any one machine has, so --all can differ from the default", () => {
    const agents = builtinAgents({ home: "/home/x" });
    expect(agents.length).toBeGreaterThan(50);
    // The gap between what peek knows and what a machine has is the point of the table.
    expect(agents.filter((a) => a.tier === "sourced").length).toBeGreaterThan(agents.filter((a) => a.tier === "verified").length);
  });

  it("marks an entry peek has resolved locally as verified and the rest as sourced", () => {
    const agents = builtinAgents({ home: "/home/x" });
    expect(bySlugRaw(agents, "claude-code").tier).toBe("verified");
    expect(bySlugRaw(agents, "zed").tier).toBe("sourced");
  });

  it("lets the overlay win over the generated table, so regeneration cannot revert a fix", () => {
    const claude = bySlugRaw(builtinAgents({ home: "/home/x" }), "claude-code");
    // The plugin root is peek's own correction; the generated table knows nothing of it.
    expect(claude.roots.some((r) => r.kind === "plugin" && r.path.endsWith("plugins/cache"))).toBe(true);
    expect(claude.adapter).toBe("claude-code");
  });

  it("gives copilot-cli a real agent record, which the adapter previously lacked", () => {
    const copilot = builtinAgents({ home: "/home/x" }).find((a) => a.adapter === "copilot-cli");
    expect(copilot).toBeDefined();
    expect(copilot!.roots.length).toBeGreaterThan(0);
  });

  it("marks a shared-tree root immutable even when it is an agent's own root", () => {
    // amp, cline, warp and zed read ~/.agents/skills directly; its content backs every
    // other agent's symlinks, so peek reports it and never offers to move it.
    const zed = bySlugRaw(builtinAgents({ home: "/home/x" }), "zed");
    const shared = zed.roots.find((r) => r.path === "/home/x/.agents/skills");
    expect(shared).toBeDefined();
    expect(shared!.kind).toBe("shared");
    expect(shared!.mutable).toBe(false);
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
    // codex gained slash_command when ticket 13 shipped its extractor; gemini still
    // sees tool calls only, so the per-adapter distinction is asserted there.
    expect(adapterObserves("codex")).toEqual(["tool_call", "slash_command"]);
    expect(adapterObserves("gemini")).toEqual(["tool_call"]);
  });

  it("reports no kinds for an adapter whose parser surfaces no tool calls", () => {
    // goose reads role/text/timestamp only; nothing to attribute a skill invocation to.
    expect(adapterObserves("goose")).toEqual([]);
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
    // gemini, not codex: codex gained slash_command with its ticket 13 extractor.
    const partial = await resolveAgent({ ...base, slug: "gemini", adapter: "gemini" });
    const blind = await resolveAgent({ ...base, slug: "cursor" });

    expect(full.observable).toBe(true);
    expect(full.observes).toContain("slash_command");

    // The state that would otherwise recommend archiving a slash-only skill.
    expect(partial.observable).toBe(true);
    expect(partial.observes).not.toContain("slash_command");

    expect(blind.observable).toBe(false);
    expect(blind.observes).toEqual([]);
  });

  it("attributes only what the shipped extractor reads, which may be less than it observes", async () => {
    // codex observes both kinds but attributes only slash commands: a codex skill
    // invocation on the tool-call path is an `exec` like any other. This is the gap
    // between seeing an invocation and knowing which skill it was.
    const codex = await resolveAgent({ displayName: "x", roots: [], slug: "codex", adapter: "codex" });
    expect(codex.observes).toEqual(["tool_call", "slash_command"]);
    expect(codex.attributes).toEqual(["slash_command"]);
    expect(codex.attributable).toBe(true);
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
    // An agent can have an adapter and still be unobservable: goose parses no tool calls.
    expect(bySlug(agents, "goose").adapter).toBe("goose");
    expect(bySlug(agents, "goose").observable).toBe(false);
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
    expect(isPresent(bySlug(agents, "gemini-cli"), new Set(["gemini"]))).toBe(true);
  });
});

describe("presence and install detection", () => {
  it("does not treat the shared tree existing as evidence an agent is installed", async () => {
    // The installer creates ~/.agents/skills for anyone who has used it once. Several
    // agents are rooted there, so root-existence alone would invent installed agents.
    const home = await fixtureHome();
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    const agents = await listAgents({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
    });
    const zed = bySlug(agents, "zed");
    expect(zed.roots.some((r) => r.present)).toBe(true);
    expect(zed.installed).toBe(false);
    expect(zed.presence).toBe("absent");
  });

  it("treats the agent's own directory as the evidence instead", async () => {
    const home = await fixtureHome();
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await mkdir(join(home, ".config", "zed"), { recursive: true });
    const agents = await listAgents({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
    });
    const zed = bySlug(agents, "zed");
    expect(zed.installed).toBe(true);
    expect(zed.presence).toBe("present");
    // Still not manageable: its root is the shared tree.
    expect(zed.manageable).toBe(false);
  });

  it("reports an agent peek knows of but has no root path for as no-convention", async () => {
    const home = await fixtureHome();
    const agents = await listAgents({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
    });
    const noConvention = agents.filter((a) => a.presence === "no-convention");
    expect(noConvention.length).toBeGreaterThan(0);
    for (const agent of noConvention) expect(agent.roots).toEqual([]);
  });

  it("reports a declared agent with nothing on disk as absent, not present", async () => {
    const home = await fixtureHome();
    const agents = await listAgents({
      home, xdgConfigHome: join(home, ".config"), stateDir: join(home, ".agent-peek"),
    });
    expect(bySlug(agents, "qoder").presence).toBe("absent");
    expect(agents.filter((a) => a.presence === "absent").length).toBeGreaterThan(50);
  });
});

describe("observes is declared on the adapter", () => {
  it("mirrors every registered adapter's own declaration", async () => {
    // The table in builtin.ts exists so callers need not load an adapter; this test is
    // what stops the two drifting apart.
    const adapters = await Promise.all([
      import("../../src/adapters/claude-code/index.js"),
      import("../../src/adapters/codex/index.js"),
      import("../../src/adapters/gemini/index.js"),
      import("../../src/adapters/goose/index.js"),
      import("../../src/adapters/opencode/index.js"),
      import("../../src/adapters/copilot-cli/index.js"),
      import("../../src/adapters/tmux/index.js"),
      import("../../src/adapters/screen/index.js"),
    ]);
    expect(adapters).toHaveLength(8);
    for (const mod of adapters) {
      const adapter = mod.default;
      expect(adapterObserves(adapter.name)).toEqual(adapter.observes ?? []);
    }
  });
});
