import fs from "node:fs";
import type { Adapter, ProjectContext } from "../../core/adapter.js";
import { discoverInText } from "../../core/discover.js";
import { FRONTEND_GLOBS } from "../../core/scan.js";
import type { FlagCandidate } from "../../core/types.js";
import { discoverTypeScript } from "./discover.js";
import { angularFlow } from "./flow.js";
import { angularUnusedDiagnostics } from "./unused.js";

/**
 * Discover candidate flag names: string literals passed to configured eval
 * methods (`.ts`/`.html`), flag registries (flags objects, enums) and
 * `environment*.ts` feature flags.
 */
export function discoverAngularFlags(ctx: ProjectContext): FlagCandidate[] {
  const out: FlagCandidate[] = [];
  const classify = { evalMethods: ctx.project.methods, attributes: [] };
  for (const file of ctx.files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    out.push(...discoverInText(text, file, ctx.name, classify));
    if (file.endsWith(".ts")) out.push(...discoverTypeScript(text, file, ctx.name));
  }
  return out;
}

export const angularAdapter: Adapter = {
  id: "angular",
  defaultGlobs: FRONTEND_GLOBS,
  discover: async (ctx) => discoverAngularFlags(ctx),
  flow: (ctx, flags) => angularFlow(ctx, flags),
  defaultCommands: () => ({ build: "npx ng build", test: "npx ng test --watch=false" }),
  unusedDiagnostics: (_ctx, input) => angularUnusedDiagnostics(input),
};
