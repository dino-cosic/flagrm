import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    // Copying a fixture and committing it can take over 10s on a loaded Windows runner.
    hookTimeout: 60_000,
  },
});
