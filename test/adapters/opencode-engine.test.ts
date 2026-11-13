// test/adapters/opencode-engine.test.ts
//
// The opencode adapter through the Engine, as `peek list` / `peek at` reach it: the
// `opencode-legacy-v1` name from PR #12 is an alias only and never renames a session.
import { describe, it, expect } from "vitest";
import { createEngine } from "../../src/index.js";
import { makeOpencodeHome, opencodeEnv } from "../helpers/opencode-home.js";
import { makeTmpHome, withEnv } from "../helpers/tmp-home.js";

describe("opencode through the engine", () => {
  it("lists both stores under opencode:<id> for --adapter opencode and its alias", async () => {
    const store = await makeOpencodeHome({ v2: true, legacy: true });
    const { home, cleanup } = await makeTmpHome();
    try {
      await withEnv({ HOME: home, ...opencodeEnv(store) }, async () => {
        const engine = await createEngine({ home });
        expect(engine.adapterNames()).not.toContain("opencode-legacy-v1");

        const direct = (await engine.list({ adapter: "opencode" })).map((s) => s.id).sort();
        const aliased = (await engine.list({ adapter: "opencode-legacy-v1" })).map((s) => s.id).sort();
        expect(aliased).toEqual(direct);
        expect(direct).toEqual([
          "opencode:ses_child", "opencode:ses_interrupted", "opencode:ses_legacy",
          "opencode:ses_running", "opencode:ses_shared", "opencode:ses_top",
        ]);

        // A legacy session is reachable by its 0.6.0 selector and through the alias.
        const viaId = await engine.peek("opencode:ses_legacy");
        const viaAlias = await engine.peek("opencode-legacy-v1:ses_legacy");
        expect(viaAlias.snapshot.sessionId).toBe("opencode:ses_legacy");
        expect(viaAlias.snapshot).toEqual(viaId.snapshot);
        // The shared session reads the V2 copy.
        const shared = await engine.peek("opencode:ses_shared");
        expect(JSON.stringify(shared.snapshot)).toContain("V2 copy of the shared session");
      });
    } finally {
      await cleanup();
    }
  });
});
