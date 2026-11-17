// test/architecture.test.ts
//
// D3.2: the layer boundaries, checked by walking every import under src/. Type-only
// imports count: the core <-> adapters cycle this guards against was a type-level one.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every relative module specifier in a source file: static, re-export, side-effect and dynamic. */
function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const pattern = /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  const found: string[] = [];
  for (const match of code.matchAll(pattern)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) found.push(spec);
  }
  return found;
}

/** The top-level directory under src/ a module lives in; `root` for src/index.ts. */
function layerOf(srcRelative: string): string {
  const [head, ...rest] = srcRelative.split(sep);
  return rest.length === 0 ? "root" : head!;
}

interface Edge { from: string; to: string }

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function importGraph(): Edge[] {
  return sourceFiles(SRC).flatMap((file) =>
    importSpecifiers(readFileSync(file, "utf8"))
      .filter((spec) => spec.startsWith("."))
      .map((spec) => ({
        from: relative(SRC, file),
        to: relative(SRC, resolve(dirname(file), spec)).replace(/\.js$/, ".ts"),
      })));
}

/** Imports that leave `fromLayer` for any of `forbidden`, as readable `a -> b` lines. */
function crossings(edges: Edge[], fromLayer: string, forbidden: readonly string[]): string[] {
  return edges
    .filter((edge) => layerOf(edge.from) === fromLayer && forbidden.includes(layerOf(edge.to)))
    .map((edge) => `${edge.from} -> ${edge.to}`);
}

const FRONT_ENDS = ["cli", "mcp"] as const;

describe("import walker", () => {
  it("finds static, type-only, re-export, side-effect and dynamic imports, and skips comments", () => {
    const source = [
      `import { a } from "./a.js";`,
      `import type { B } from "../core/b.js";`,
      `export { c } from "./c.js";`,
      `export * from "./d.js";`,
      `import "./side-effect.js";`,
      `const e = await import("./e.js");`,
      `import {`,
      `  f,`,
      `} from "./f.js";`,
      `// import { g } from "./g.js";`,
      `/* import { h } from "./h.js"; */`,
    ].join("\n");
    expect(importSpecifiers(source)).toEqual([
      "./a.js", "../core/b.js", "./c.js", "./d.js", "./side-effect.js", "./e.js", "./f.js",
    ]);
  });

  it("resolves the real graph, including the app layer's use of concrete adapters", () => {
    const edges = importGraph();
    expect(edges.length).toBeGreaterThan(100);
    expect(edges).toContainEqual({ from: join("app", "adapters.ts"), to: join("adapters", "claude-code", "index.ts") });
    expect(edges.some((edge) => layerOf(edge.from) === "cli" && layerOf(edge.to) === "app")).toBe(true);
    expect(edges.some((edge) => layerOf(edge.from) === "mcp" && layerOf(edge.to) === "app")).toBe(true);
  });

  it("would report a forbidden import", () => {
    const edges = [{ from: join("core", "engine.ts"), to: join("adapters", "loader.ts") }];
    expect(crossings(edges, "core", ["adapters"])).toEqual([`${join("core", "engine.ts")} -> ${join("adapters", "loader.ts")}`]);
  });
});

describe("layer boundaries (D3.2)", () => {
  const edges = importGraph();

  it("core imports no adapters, services or front ends", () => {
    expect(crossings(edges, "core", ["adapters", "app", ...FRONT_ENDS])).toEqual([]);
  });

  it("no service imports from the CLI or MCP front ends", () => {
    expect(crossings(edges, "app", FRONT_ENDS)).toEqual([]);
  });

  it("adapters sit below the service layer and the front ends", () => {
    expect(crossings(edges, "adapters", ["app", ...FRONT_ENDS])).toEqual([]);
  });

  it("no library layer reaches up into a front end", () => {
    for (const layer of ["agents", "export", "feed", "skills", "usage"]) {
      expect(crossings(edges, layer, ["app", ...FRONT_ENDS]), layer).toEqual([]);
    }
  });
});
