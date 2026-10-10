/**
 * The `coverage` check: a file the removal changed that no build, test or
 * lint command checks is a warning. A project covers a file inside its path
 * when it ran a command in this verify (or has one `--skip` left out) and one
 * of its `covers` globs (relative to its path; default: everything) matches
 * the file. A file that was already dirty at the baseline and hasn't changed
 * since is no edit of the removal.
 */

import path from "node:path";
import { excludeMatcher } from "../change-filter.js";
import { projectCommands } from "../config-snapshot.js";
import { blobIds } from "../git.js";
import { type CheckFinding, type CheckResult, RUN_CHECK_ID } from "../types.js";
import { relativePath } from "../util.js";
import { checkResult, plural, skippedResult, type VerifyContext } from "./context.js";

/** More uncovered files than this are counted per top-level directory instead. */
const MAX_FILES = 20;

const UNCHECKED = "no build, test or lint command checks";

export function coverageCheck(v: VerifyContext): CheckResult {
  if (!v.changedFiles) return skippedResult("coverage", "no baseline commit to diff against");
  const skipped = (Object.keys(RUN_CHECK_ID) as Array<keyof typeof RUN_CHECK_ID>).filter((kind) =>
    v.skip?.has(RUN_CHECK_ID[kind]),
  );
  if (skipped.length === 3)
    return skippedResult("coverage", "build, tests and lint skipped (--skip), so no command ran");
  const ran = new Set(v.runs.map((r) => r.project));
  const projects = v.projects.map(({ adapter, ctx }) => {
    const covers = ctx.project.covers;
    const commands = projectCommands(adapter, ctx);
    return {
      name: ctx.name,
      root: ctx.root,
      // A command --skip left out would have checked the file: no reason to warn about the config.
      ran: ran.has(ctx.name) || skipped.some((kind) => commands[kind]),
      covers: covers ? excludeMatcher(covers.map(coversGlob)) : () => true,
    };
  });
  const uncovered: Array<{ file: string; project?: string }> = [];
  for (const file of removalFiles(v, v.changedFiles)) {
    const containing = projects
      .map((p) => ({ ...p, rel: relativePath(p.root, path.join(v.root, file)) }))
      .filter((p) => p.rel !== ".." && !p.rel.startsWith("../") && !path.isAbsolute(p.rel));
    if (containing.some((p) => p.ran && p.covers(p.rel))) continue;
    const innermost = containing.sort((a, b) => b.root.length - a.root.length)[0];
    uncovered.push({ file, project: innermost?.name });
  }
  if (uncovered.length === 0) return checkResult("coverage", "every changed file is built, tested or linted", []);
  const findings =
    uncovered.length > MAX_FILES
      ? byDirectory(uncovered)
      : uncovered.map(
          ({ file, project }): CheckFinding => ({
            severity: "warn",
            message: `${file}: ${UNCHECKED} it`,
            ...(project ? { project } : {}),
          }),
        );
  return checkResult("coverage", `${plural(uncovered.length, "changed file")} no command checks`, findings);
}

/** The changed files without the ones dirty at the baseline and unchanged since (all of them, for a baseline without their hashes). */
function removalFiles(v: VerifyContext, changed: string[]): string[] {
  const { dirtyFiles = [], dirtyHashes } = v.baseline.git ?? {};
  const dirty = new Set(dirtyFiles);
  const candidates = changed.filter((rel) => dirty.has(rel));
  if (candidates.length === 0) return changed;
  if (!dirtyHashes) return changed.filter((rel) => !dirty.has(rel));
  const now = blobIds(v.root, candidates);
  return changed.filter((rel) => !dirty.has(rel) || !(rel in dirtyHashes) || now[rel] !== dirtyHashes[rel]);
}

/** A `covers` entry as a glob: `./src/**` is how the rest of the config writes paths, and `./` or `.` is everything. */
function coversGlob(glob: string): string {
  const rel = glob.replace(/^\.\//, "").replace(/\/+$/, "");
  return rel === "" || rel === "." ? "**" : rel;
}

/** One warning per top-level directory (`.` for files in the root) with its count. */
function byDirectory(uncovered: Array<{ file: string }>): CheckFinding[] {
  const counts = new Map<string, number>();
  for (const { file } of uncovered) {
    const slash = file.indexOf("/");
    const dir = slash === -1 ? "." : `${file.slice(0, slash)}/`;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, n]) => ({ severity: "warn", message: `${dir}: ${plural(n, "changed file")} ${UNCHECKED}` }));
}
