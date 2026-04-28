import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/types.ts", "src/cli/index.ts", "src/mcp/index.ts"],
      thresholds: { lines: 85, statements: 85, functions: 80, branches: 75 },
    },
  },
});
