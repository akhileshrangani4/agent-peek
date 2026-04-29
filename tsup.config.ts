import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/adapters/types.ts",
    "src/mcp/index.ts",
    "src/cli/index.ts",
    "src/cli/ui.ts"
  ],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
});
