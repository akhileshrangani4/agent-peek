import { describe, it, expect } from "vitest";
import { VERSION, createEngine } from "../../src/index.js";
import { makeTmpHome } from "../helpers/tmp-home.js";

describe("smoke", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.1.1");
  });

  it("createEngine returns an engine that can list (zero sessions on tmp home)", async () => {
    const { home, cleanup } = await makeTmpHome();
    process.env.HOME = home;
    const engine = await createEngine({ home });
    const list = await engine.list();
    expect(Array.isArray(list)).toBe(true);
    await cleanup();
  });
});
