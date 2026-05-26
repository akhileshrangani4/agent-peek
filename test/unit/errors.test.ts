import { describe, it, expect } from "vitest";
import {
  SessionNotFoundError,
  AmbiguousSelectorError,
  AdapterError,
  AdapterNotFoundError,
  CursorMismatchError,
  InvalidCursorError,
  RegistryLockTimeoutError,
} from "../../src/core/errors.js";

describe("errors", () => {
  it("SessionNotFoundError carries selector", () => {
    const e = new SessionNotFoundError("foo");
    expect(e.name).toBe("SessionNotFoundError");
    expect(e.selector).toBe("foo");
    expect(e.message).toMatch(/foo/);
    expect(e instanceof Error).toBe(true);
  });

  it("AmbiguousSelectorError carries candidates", () => {
    const e = new AmbiguousSelectorError("re", ["a", "b"]);
    expect(e.candidates).toEqual(["a", "b"]);
    expect(e.message).toMatch(/re/);
  });

  it("AdapterError wraps cause", () => {
    const cause = new Error("boom");
    const e = new AdapterError("claude-code", "scan failed", cause);
    expect(e.adapter).toBe("claude-code");
    expect(e.cause).toBe(cause);
  });

  it("AdapterNotFoundError carries adapter name", () => {
    const e = new AdapterNotFoundError("nope");
    expect(e.adapter).toBe("nope");
  });

  it("CursorMismatchError surfaces both adapters", () => {
    const e = new CursorMismatchError("a", "b");
    expect(e.cursorAdapter).toBe("a");
    expect(e.sessionAdapter).toBe("b");
  });

  it("InvalidCursorError names malformed cursors", () => {
    const e = new InvalidCursorError("bad shape");
    expect(e.name).toBe("InvalidCursorError");
    expect(e.message).toMatch(/bad shape/);
  });

  it("RegistryLockTimeoutError exists", () => {
    const e = new RegistryLockTimeoutError();
    expect(e.name).toBe("RegistryLockTimeoutError");
  });
});
