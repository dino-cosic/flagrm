/**
 * The `coverage` check: a changed file that no build, test or lint command
 * checks is a warning. A project covers a file inside its path when it ran a
 * command in this verify and one of its `covers` globs (relative to its path;
 * default: everything) matches the file.
 */

import path from "node:path";
import picomatch from "picomatch";
import type { CheckFinding, CheckResult } from "../types.js";
import { relativePath } from "../util.js";
import { checkResult, plural, skippedResult, type VerifyContext } from "./context.js";

/** More uncovered files than this are counted per top-level directory instead. */
const MAX_FILES = 20;

const UNCHECKED = "no build, test or lint command checks";

export function coverageCheck(v: VerifyContext): CheckResult {
  if (!v.changedFiles) return skippedResult("coverage", "no baseline commit to diff against");
  const ran = new Set(v.runs.map((r) => r.project));
  const projects = v.projects.map(({ ctx }) => {
    // `./src/**` is how the rest of the config writes paths.
    const covers = ctx.project.covers?.map((glob) => glob.replace(/^\.\//, ""));
    return {
      name: ctx.name,
      root: ctx.root,
      ran: ran.has(ctx.name),
      covers: covers ? picomatch(covers, { dot: true }) : () => true,
    };
  });
  const uncovered: Array<{ file: string; project?: string }> = [];
  for (const file of v.changedFiles) {
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
