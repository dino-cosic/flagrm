/**
 * Build commands that run but can't give verify what it needs; `doctor` and
 * verify's build check warn about them.
 */

import type { Adapter } from "./adapter.js";

/**
 * Why an Angular project's build can't catch template errors, if it can't:
 * `tsc` never reads templates, so a member removed or renamed in a component
 * but still used in its `.html` passes the build. `ngc` and `ng build` check them.
 */
export function templateCheckGap(adapter: Adapter, build: string | undefined): string | undefined {
  if (adapter.id !== "angular" || !build || !/\btsc\b/.test(build)) return undefined;
  if (/\bngc\b|\bng\s+build\b|\bnx\b/.test(build)) return undefined;
  return "`tsc` doesn't type-check Angular templates: add `npx ngc -p <app>/tsconfig.json --noEmit` to `build` so a member removed from a component but still used in its template fails the build";
}

/**
 * Why a .NET build can't feed the dead-code check, if it can't: an incremental
 * `dotnet build` skips compiling up-to-date projects and prints none of their
 * warnings, so a baseline taken on a built tree records no pre-existing unused
 * code and verify reports all of it as new.
 */
export function incrementalBuildGap(adapter: Adapter, build: string | undefined): string | undefined {
  if (adapter.id !== "dotnet" || !build || !/\bdotnet\s+build\b/.test(build)) return undefined;
  if (/--no-incremental\b|[-/]t(arget)?:\s*Rebuild\b/i.test(build)) return undefined;
  return "`dotnet build` without `--no-incremental` skips up-to-date projects and prints none of their warnings, so the dead-code check may report existing unused code as new: add `--no-incremental` to `build`";
}
