import { describe, it, expect } from "vitest";
import { VERSION, createEngine } from "../../src/index.js";
import packageJson from "../../package.json";
import { makeTmpHome } from "../helpers/tmp-home.js";

describe("smoke", () => {
  it("exposes the package version", () => {
    expect(VERSION).toBe(packageJson.version);
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
