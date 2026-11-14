// test/app/adapters.test.ts
//
// The adapter composition root. Loader basics (register, alias collisions, unknown
// names) live in test/unit/loader.test.ts; this covers what the app layer adds: the
// built-in set and its order, the OpenCode legacy alias, agent-word lookup and
// external discovery.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterLoader, BUILTIN_ADAPTERS, BUILTIN_ADAPTER_ALIASES, TERMINAL_ADAPTERS,
  builtinAdapterNamed, createAdapterLoader, discoverExternal, isTerminalAdapter, registerBuiltinAdapters,
} from "../../src/app/adapters.js";
import { withEnv } from "../helpers/tmp-home.js";

describe("built-in adapters", () => {
  it("registers every built-in in the 0.6 scan order, plus the legacy OpenCode alias", () => {
    const loader = new AdapterLoader();
    registerBuiltinAdapters(loader);
    expect(loader.names()).toEqual(["claude-code", "codex", "copilot-cli", "gemini", "goose", "opencode", "screen", "tmux"]);
    expect(loader.names()).toEqual(BUILTIN_ADAPTERS.map((adapter) => adapter.name));
    expect([...BUILTIN_ADAPTER_ALIASES]).toEqual([["opencode-legacy-v1", "opencode"]]);
    expect(loader.get("opencode-legacy-v1")).toBe(loader.get("opencode"));
    expect(loader.canonical("opencode-legacy-v1")).toBe("opencode");
  });

  it("treats only tmux and screen as terminal capture", () => {
    expect([...TERMINAL_ADAPTERS].sort()).toEqual(["screen", "tmux"]);
    expect(isTerminalAdapter("tmux")).toBe(true);
    expect(isTerminalAdapter("opencode")).toBe(false);
    expect(isTerminalAdapter(undefined)).toBe(false);
    expect(isTerminalAdapter(42)).toBe(false);
  });

  it("names the adapter a bare word stands for", () => {
    expect(builtinAdapterNamed("codex")).toBe("codex");
    expect(builtinAdapterNamed("Codex")).toBe("codex");
    expect(builtinAdapterNamed("claude")).toBe("claude-code");
    expect(builtinAdapterNamed("copilot")).toBe("copilot-cli");
    expect(builtinAdapterNamed("opencode-legacy-v1")).toBe("opencode");
    expect(builtinAdapterNamed("my-session")).toBeUndefined();
  });

  it("never resolves an Object.prototype member as an adapter", () => {
    for (const word of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(builtinAdapterNamed(word)).toBeUndefined();
    }
  });
});

describe("adapter set composition", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.restoreAllMocks();
  });

  function plugin(name: string, body: string): string {
    dir ??= mkdtempSync(join(tmpdir(), "ap-plugins-"));
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  }

  const validPlugin = `export default { name: "ext", async scan() { return []; }, async read() { return { messages: [], nextCursor: "", eof: true }; } };`;

  it("builds the built-ins by default and nothing when told not to", async () => {
    expect((await createAdapterLoader()).names()).toHaveLength(BUILTIN_ADAPTERS.length);
    expect((await createAdapterLoader({ withBuiltins: false })).names()).toEqual([]);
  });

  it("loads external adapters only when asked", async () => {
    const path = plugin("ext.mjs", validPlugin);
    await withEnv({ AGENT_PEEK_ADAPTER_PATH: path }, async () => {
      expect((await createAdapterLoader({ withBuiltins: false })).names()).toEqual([]);
      expect((await createAdapterLoader({ withBuiltins: false, withExternal: true })).names()).toEqual(["ext"]);
    });
  });

  it("does nothing without AGENT_PEEK_ADAPTER_PATH", async () => {
    const loader = new AdapterLoader();
    await withEnv({ AGENT_PEEK_ADAPTER_PATH: "" }, () => discoverExternal(loader));
    expect(loader.names()).toEqual([]);
  });

  it("skips modules that are not adapters and never replaces a registered one", async () => {
    const notAdapter = plugin("not-adapter.mjs", `export default { name: "half" };`);
    const shadow = plugin("shadow.mjs", `export default { name: "codex", async scan() { return []; }, async read() { return {}; } };`);
    const loader = new AdapterLoader();
    registerBuiltinAdapters(loader);
    const codex = loader.get("codex");
    await withEnv({ AGENT_PEEK_ADAPTER_PATH: `${notAdapter}:${shadow}` }, () => discoverExternal(loader));
    expect(loader.has("half")).toBe(false);
    expect(loader.get("codex")).toBe(codex);
  });

  it("reports a plugin that fails to load and keeps loading the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = plugin("broken.mjs", "export default {");
    const good = plugin("good.mjs", validPlugin);
    const loader = new AdapterLoader();
    await withEnv({ AGENT_PEEK_ADAPTER_PATH: `${broken}:${good}` }, () => discoverExternal(loader));
    expect(loader.names()).toEqual(["ext"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(`failed to load adapter from ${broken}`);
  });
});
