/**
 * The generic adapter: discovery and verification for any stack, configured
 * by `globs` and `methods` (eval method names).
 */

import fs from "node:fs";
import path from "node:path";
import type { Adapter, ProjectContext } from "../../core/adapter.js";
import { discoverGeneric } from "./discover.js";

/**
 * Common source and configuration files, minus vendored dependencies, build
 * output and lock files (on top of the global ignore list). Set `globs` on the
 * project to replace them.
 */
export const GENERIC_GLOBS = [
  "**/*.{go,py,rb,java,kt,kts,scala,swift,rs,php,dart,c,h,cc,cpp,hpp,cs,js,jsx,mjs,cjs,ts,tsx,html,vue,svelte}",
  "**/*.{json,yaml,yml,toml,properties,ini}",
  "**/.env",
  "**/.env.*",
  "!**/vendor/**",
  "!**/target/**",
  "!**/venv/**",
  "!**/__pycache__/**",
  "!**/package-lock.json",
];

/** Build and test commands inferred from the project's manifest: Go modules, Cargo, npm scripts. */
function defaultCommands(ctx: ProjectContext): { build?: string; test?: string } {
  const has = (file: string) => fs.existsSync(path.join(ctx.root, file));
  if (has("go.mod")) return { build: "go build ./...", test: "go test ./..." };
  if (has("Cargo.toml")) return { build: "cargo build", test: "cargo test" };
  if (has("package.json")) {
    try {
      const scripts = JSON.parse(fs.readFileSync(path.join(ctx.root, "package.json"), "utf8")).scripts ?? {};
      return {
        ...(scripts.build ? { build: "npm run build" } : {}),
        ...(scripts.test ? { test: "npm test" } : {}),
      };
    } catch {
      return {};
    }
  }
  return {};
}

export const genericAdapter: Adapter = {
  id: "generic",
  defaultGlobs: GENERIC_GLOBS,
  discover: async (ctx) => discoverGeneric(ctx),
  defaultCommands,
};
