import { progress } from "../../src/core/progress.js";

// In-process tests run real build and test commands; their progress lines would only clutter vitest's output.
// The spawned CLI (test/cli.test.ts) still prints them.
progress.write = () => {};
