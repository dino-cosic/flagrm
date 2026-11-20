/**
 * Vitest global setup: `cli.test.ts` and `skills.test.ts` spawn the built
 * `dist/cli.js`, so rebuild it first when it is missing or older than any
 * file under `src/` (or the build config). Otherwise `npm test` after an edit
 * would test the previous build and pass or fail for the wrong reason.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function newest(dir: string): number {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) latest = Math.max(latest, fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  }
  return latest;
}

export default function setup(): void {
  const cli = path.join(ROOT, "dist", "cli.js");
  const built = fs.existsSync(cli) ? fs.statSync(cli).mtimeMs : 0;
  const sources = Math.max(
    newest(path.join(ROOT, "src")),
    ...["tsconfig.json", "package.json"].map((f) => fs.statSync(path.join(ROOT, f)).mtimeMs),
  );
  if (built >= sources) return;
  // Through node, not npm: no shell needed on Windows, and `npm run build` only cleans dist/ and runs tsc.
  fs.rmSync(path.join(ROOT, "dist"), { recursive: true, force: true });
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: ROOT, stdio: "inherit" });
}
