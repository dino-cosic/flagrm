/**
 * A file-scoped name (a local, parameter or field) is also used in the files
 * that share its file's scope, such as an Angular component's template. The
 * adapter whose project contains the file says which (`Adapter.scopeFiles`).
 */

import path from "node:path";
import type { Workspace } from "./adapter.js";
import { relativePath } from "./util.js";

/** `rel` (relative to the config `root`) followed by the files sharing its scope, relative too, each once. */
export function withScopeFiles(projects: Workspace, root: string, rel: string): string[] {
  const file = path.resolve(root, rel);
  const owner = projects.find(({ ctx }) => !path.relative(ctx.root, file).startsWith(".."));
  const more = owner?.adapter.scopeFiles?.(owner.ctx, file) ?? [];
  return [...new Set([rel, ...more.map((f) => relativePath(root, f))])];
}
