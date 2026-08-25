import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/types.ts", "src/cli/index.ts", "src/cli/ui.ts", "src/mcp/index.ts"],
      // Thresholds recalibrated for vitest 4's stricter v8 branch remapping
      // (same code scored ~91% lines / ~79% branches under vitest 1).
      thresholds: { lines: 85, statements: 84, functions: 80, branches: 70 },
    },
  },
});
