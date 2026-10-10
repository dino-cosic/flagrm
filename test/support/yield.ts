import { afterEach } from "vitest";

// Tests that spawn synchronously (`spawnSync`) block the worker's event loop, so
// it can't read vitest's replies; a file of them running past 60s on a slow
// Windows runner fails with `Timeout calling "onTaskUpdate"`. Yield one event
// loop turn after each test to let the replies in.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
