import fs from "node:fs";
import path from "node:path";
import type { Adapter, ProjectContext } from "../../core/adapter.js";
import { discoverInText } from "../../core/discover.js";
import { FRONTEND_GLOBS } from "../../core/scan.js";
import { detectTestRunner, runnerTestCommands, type TestRunner } from "../../core/test-runner.js";
import type { FlagCandidate } from "../../core/types.js";
import { componentScopeFiles } from "./component-files.js";
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

/** The runner per project directory: projectCommands asks for the default commands many times per command. */
const runners = new Map<string, TestRunner>();

function testRunner(root: string): TestRunner {
  let runner = runners.get(root);
  if (!runner) runners.set(root, (runner = detectTestRunner(root)));
  return runner;
}

export const angularAdapter: Adapter = {
  id: "angular",
  defaultGlobs: FRONTEND_GLOBS,
  discover: async (ctx) => discoverAngularFlags(ctx),
  flow: (ctx, flags) => angularFlow(ctx, flags, ctx.project.methods),
  scopeFiles: (_ctx, file) => componentScopeFiles(file),
  // Like the .NET adapter: when the runner can write results without setup, the default test command does, under .flagrm/.
  defaultCommands: (ctx) => {
    const dir = path.join(ctx.config.root, ".flagrm", "test-results", ctx.name);
    const tests = runnerTestCommands(testRunner(ctx.root), ctx.root, dir);
    return { build: "npx ng build", ...(tests ?? { test: "npx ng test --watch=false" }) };
  },
  unusedDiagnostics: (_ctx, input) => angularUnusedDiagnostics(input),
};
