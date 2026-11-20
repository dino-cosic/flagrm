import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/support/yield.ts", "test/support/quiet.ts"],
    // Rebuilds dist/ when src/ is newer: the CLI tests spawn the built cli.js.
    globalSetup: ["test/support/build.ts"],
    testTimeout: 60_000,
    // Copying a fixture and committing it can take over 10s on a loaded Windows runner.
    hookTimeout: 60_000,
  },
});
