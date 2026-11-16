/**
 * One read per file per command. discovery, the flow analysis and every
 * verify scanner walk the same files; they share this cache through
 * `ProjectContext.text`, so text is also normalized (`\r\n` to `\n`) in one place.
 */

import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "./adapter.js";
import { toLf } from "./text-utils.js";

/** A file's text with `\n` line endings, or undefined when it can't be read. */
export type ReadText = (file: string) => string | undefined;

/**
 * A reader that reads each file at most once. It never sees later edits, so
 * create one per command (as `resolveProjects` does), not per process.
 */
export function cachedTextReader(): ReadText {
  const cache = new Map<string, string | undefined>();
  return (file) => {
    const key = path.resolve(file);
    if (cache.has(key)) return cache.get(key);
    let text: string | undefined;
    try {
      text = toLf(fs.readFileSync(key, "utf8"));
    } catch {
      text = undefined;
    }
    cache.set(key, text);
    return text;
  };
}

/** The workspace's shared reader (every project's `ctx.text` is the same one), or a fresh one without projects. */
export function workspaceText(projects: Workspace): ReadText {
  return projects[0]?.ctx.text ?? cachedTextReader();
}
