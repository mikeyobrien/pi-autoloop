import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["context-floor.ts", "session-loop.ts", "markers.ts", "emit-tool.ts", "restore.ts"],
      reporter: ["text"],
      thresholds: { lines: 90, branches: 90 },
    },
  },
});
