import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor, cursorAdapter } from "../../src/core/cursor.js";
import { CursorMismatchError } from "../../src/core/errors.js";

describe("cursor", () => {
  it("round-trips data", () => {
    const data = { adapter: "claude-code", byteOffset: 4321, msgIndex: 17 };
    const c = encodeCursor(data);
    expect(typeof c).toBe("string");
    expect(decodeCursor(c)).toEqual(data);
  });

  it("decodes adapter without full decode", () => {
    const c = encodeCursor({ adapter: "codex", byteOffset: 0, msgIndex: 0 });
    expect(cursorAdapter(c)).toBe("codex");
  });

  it("rejects mismatched adapter via decodeCursor", () => {
    const c = encodeCursor({ adapter: "x", byteOffset: 0, msgIndex: 0 });
    expect(() => decodeCursor(c, "y")).toThrow(CursorMismatchError);
  });

  it("throws on garbage cursor", () => {
    expect(() => decodeCursor("not-base64!@#")).toThrow();
  });
});
