// test/unit/loader.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { AdapterLoader } from "../../src/adapters/loader.js";
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
});
