import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/support/yield.ts", "test/support/quiet.ts"],
    // Rebuilds dist/ when src/ is newer: the CLI tests spawn the built cli.js.
    globalSetup: ["test/support/build.ts"],
    // Copying a fixture and committing it can take over 10s on a loaded Windows runner, and the realistic-fixture
    // verify tests over a minute there.
    testTimeout: process.platform === "win32" ? 180_000 : 60_000,
    hookTimeout: process.platform === "win32" ? 180_000 : 60_000,
  },
});
