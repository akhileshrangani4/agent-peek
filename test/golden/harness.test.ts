// test/golden/harness.test.ts
//
// The golden suites are only as good as their normaliser and their list projection: a rule
// that is too broad hides a real change, one that is too narrow makes the goldens flaky.
// These tests pin each documented rule in normalize.ts and the additions-only contract of
// projectOntoBaseline.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { projectOntoBaseline, serialize, structure } from "./harness.js";
import { Normalizer, RUN_WINDOW_MS } from "./normalize.js";
import { REPO_ROOT } from "./fixture-home.js";

const HOME = "/tmp/ap-golden-abc123";
const RUN = Date.parse("2026-11-13T12:00:00.000Z");

function normalizer(stableIds: string[] = []): Normalizer {
  return new Normalizer({ home: HOME, runStartedAt: RUN, stableIds });
}

describe("Normalizer", () => {
  it("rewrites the fixture home, the checkout and the node binary, and leaves fixture data paths alone", () => {
    const n = normalizer();
    expect(n.value({ a: `${HOME}/repo/src/x.ts`, b: `${REPO_ROOT}/bin/peek.js`, c: process.execPath, d: "/tmp/repo/auth.ts" }))
      .toEqual({ a: "<HOME>/repo/src/x.ts", b: "<REPO>/bin/peek.js", c: "<NODE>", d: "/tmp/repo/auth.ts" });
  });

  it("rewrites the user@host fallback identity", () => {
    expect(normalizer().string(`${userInfo().username}@${hostname()}:${HOME}/repo`)).toBe("<USER>@<HOST>:<HOME>/repo");
  });

  it("replaces run-time instants and keeps fixture instants", () => {
    const n = normalizer();
    const recent = new Date(RUN - RUN_WINDOW_MS + 1000).toISOString();
    const future = new Date(RUN + 30 * 86_400_000).toISOString();
    expect(n.value({ createdAt: recent, expiresAt: future, lastSeen: "2026-04-28T14:00:00.000Z" }))
      .toEqual({ createdAt: "<NOW>", expiresAt: "<NOW>", lastSeen: "2026-04-28T14:00:00.000Z" });
  });

  it("numbers generated ids by first appearance and keeps stable fixture ids", () => {
    const stable = "019cbabb-1261-7393-8ae4-007653e6c643";
    const n = normalizer([stable]);
    const claim = "6f1c2a4e-9b7d-4e1f-8a3c-2d5e7f9a1b3c";
    const post = "mhx3k2a9z-1a2b3c4d";
    expect(n.value([claim, post, claim, `codex:${stable}`, `see ${post}`]))
      .toEqual(["<ID:1>", "<ID:2>", "<ID:1>", `codex:${stable}`, "see <ID:2>"]);
  });

  it("decodes opaque cursors and normalises their contents", () => {
    const cursor = Buffer.from(JSON.stringify({ v: 1, w: new Date(RUN).toISOString(), d: [] })).toString("base64url");
    expect(normalizer().value({ nextCursor: cursor })).toEqual({ nextCursor: { $cursor: { v: 1, w: "<NOW>", d: [] } } });
  });

  it("leaves strings that are not cursors alone, even if base64-looking", () => {
    expect(normalizer().string("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  it("rewrites the package and node versions, but not a longer number containing them", () => {
    const n = normalizer();
    const version = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
    expect(n.string(`node ${process.version}`)).toBe("node <NODE_VERSION>");
    expect(n.string(`peek/${version}`)).toBe("peek/<VERSION>");
    expect(n.string(`1${version} and ${version}1`)).toBe(`1${version} and ${version}1`);
  });

  it("replaces elapsed-time fields only", () => {
    expect(normalizer().value({ durationMs: 12, tookMs: 3, ttlMs: 3600000, count: 4 }))
      .toEqual({ durationMs: "<MS>", tookMs: "<MS>", ttlMs: 3600000, count: 4 });
  });
});

describe("structure", () => {
  it("parses JSON output and splits text output into lines", () => {
    expect(structure('{"a":1}\n')).toEqual({ a: 1 });
    expect(structure("one\ntwo\n")).toEqual(["one", "two"]);
    expect(structure("[not json\n")).toEqual(["[not json"]);
    expect(structure("")).toBeNull();
  });
});

describe("projectOntoBaseline", () => {
  const baseline = ["a", "b"] as const;
  const a = { name: "a", inputSchema: { type: "object" } };
  const b = { name: "b", inputSchema: { type: "object" } };

  it("ignores additions, so a new tool leaves the golden unchanged", () => {
    const before = projectOntoBaseline([a, b], baseline);
    const after = projectOntoBaseline([a, { name: "new_tool" }, b], baseline);
    expect(serialize(after.recorded)).toBe(serialize(before.recorded));
    expect(after.missing).toEqual([]);
    expect(after.added).toEqual(["new_tool"]);
  });

  it("reports a removed baseline entry", () => {
    expect(projectOntoBaseline([a], baseline).missing).toEqual(["b"]);
  });

  it("changes the recorded projection when a baseline entry is reshaped", () => {
    const reshaped = { name: "b", inputSchema: { type: "object", required: ["project"] } };
    expect(serialize(projectOntoBaseline([a, reshaped], baseline).recorded))
      .not.toBe(serialize(projectOntoBaseline([a, b], baseline).recorded));
  });

  it("records in baseline order, so reordering registration is not a change", () => {
    expect(serialize(projectOntoBaseline([b, a], baseline).recorded)).toBe(serialize(projectOntoBaseline([a, b], baseline).recorded));
  });
});
