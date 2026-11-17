// test/unit/loader.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { AdapterLoader } from "../../src/app/adapters.js";
import { AdapterNotFoundError } from "../../src/core/errors.js";
import type { Adapter } from "../../src/adapters/types.js";

const fakeAdapter = (name: string): Adapter => ({
  name,
  async scan() { return []; },
  async read() { return { messages: [], nextCursor: "", eof: true }; },
});

describe("AdapterLoader", () => {
  let loader: AdapterLoader;
  beforeEach(() => { loader = new AdapterLoader(); });

  it("registers built-in adapters", () => {
    loader.register(fakeAdapter("claude-code"));
    expect(loader.get("claude-code").name).toBe("claude-code");
  });

  it("throws AdapterNotFoundError for unknown adapter", () => {
    expect(() => loader.get("nope")).toThrow(AdapterNotFoundError);
  });

  it("lists registered names", () => {
    loader.register(fakeAdapter("a"));
    loader.register(fakeAdapter("b"));
    expect(loader.names().sort()).toEqual(["a", "b"]);
  });

  it("rejects duplicate registration", () => {
    loader.register(fakeAdapter("a"));
    expect(() => loader.register(fakeAdapter("a"))).toThrow(/already registered/);
  });

  it("resolves an alias to its target without listing it", () => {
    loader.register(fakeAdapter("opencode"));
    loader.alias("opencode-legacy-v1", "opencode");
    expect(loader.has("opencode-legacy-v1")).toBe(true);
    expect(loader.get("opencode-legacy-v1").name).toBe("opencode");
    expect(loader.canonical("opencode-legacy-v1")).toBe("opencode");
    expect(loader.canonical("opencode")).toBe("opencode");
    expect(loader.names()).toEqual(["opencode"]);
  });

  it("rejects an alias that collides or points nowhere", () => {
    loader.register(fakeAdapter("a"));
    loader.alias("x", "a");
    expect(() => loader.alias("a", "a")).toThrow(/already registered/);
    expect(() => loader.alias("x", "a")).toThrow(/already registered/);
    expect(() => loader.register(fakeAdapter("x"))).toThrow(/already registered/);
    expect(() => loader.alias("y", "missing")).toThrow(AdapterNotFoundError);
  });
});
