import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/types.ts",
        // Presentation. `index.ts` and `ui.ts` were already excluded on this basis;
        // ticket 15 moved every static report into its own module, so the same reasoning
        // now covers five more files and the shared renderer.
        //
        // The decision is deliberate rather than a convenience: a coverage number for
        // terminal layout is bought with snapshot tests over exact spacing and colour,
        // which have to be rewritten on every design change (four in one day, so far)
        // and which fail on restyles while passing on lost capabilities. Ticket 15 has
        // two behavioural invariants instead -- no escape codes off a TTY, and every
        // state legible without colour -- which is what actually needs to hold.
        //
        // Logic keeps the original thresholds. Aggregation, inventory, prune semantics
        // and the agent registry are where a wrong answer costs a user a skill they
        // rely on, and none of those are excluded.
        "src/cli/index.ts",
        "src/cli/ui.ts",
        "src/cli/render.ts",
        "src/cli/*-report.ts",
        "src/cli/skills-ui.ts",
        "src/mcp/index.ts",
      ],
      // Thresholds recalibrated for vitest 4's stricter v8 branch remapping
      // (same code scored ~91% lines / ~79% branches under vitest 1).
      thresholds: { lines: 85, statements: 84, functions: 80, branches: 70 },
    },
  },
});
