import fs from "node:fs";
import path from "node:path";
import type { Adapter, ProjectContext } from "../../core/adapter.js";
import { discoverInText } from "../../core/discover.js";
import { BACKEND_GLOBS } from "../../core/scan.js";
import type { FlagCandidate } from "../../core/types.js";
import { relativePath } from "../../core/util.js";
import { dotnetFlow } from "./flow.js";
import { dotnetUnusedDiagnostics } from "./unused.js";

/** Discover candidate flag names (appsettings config keys, [FeatureGate] args, eval-call literals, *Flags constants/enums). */
export function discoverDotnetFlags(ctx: ProjectContext): FlagCandidate[] {
  const out: FlagCandidate[] = [];
  const classify = { evalMethods: ctx.project.methods, attributes: ctx.project.attributes };
  for (const file of ctx.files) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    out.push(...discoverInText(text, file, ctx.name, classify));
  }
  return out;
}

export const dotnetAdapter: Adapter = {
  id: "dotnet",
  defaultGlobs: BACKEND_GLOBS,
  discover: async (ctx) => discoverDotnetFlags(ctx),
  flow: (ctx, flags) => dotnetFlow(ctx, flags, ctx.project.methods),
  // --no-incremental: an up-to-date project skips compiling and prints none of its
  // warnings, so the baseline's dead-code comparison would have nothing to subtract.
  // TRX under .flagrm/, so verify compares tests by name (known failures) out of the box.
  defaultCommands: (ctx) => {
    const dir = path.join(ctx.config.root, ".flagrm", "test-results", ctx.name);
    return {
      build: "dotnet build --no-incremental",
      test: `dotnet test --logger trx --results-directory "${relativePath(ctx.root, dir) || "."}"`,
      testResults: path.join(dir, "*.trx"),
    };
  },
  unusedDiagnostics: (_ctx, input) => dotnetUnusedDiagnostics(input),
};
