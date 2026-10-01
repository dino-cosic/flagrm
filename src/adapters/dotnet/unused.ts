/**
 * .NET "unused" diagnostics for `verify`'s dead-code check, read from the
 * build output: compiler warnings that are on by default (CS0169 unused
 * field, CS0414 assigned but never read, CS0168/CS0219 unused locals, CS8321
 * unused local function, CS9113 unread primary-constructor parameter) and the IDE analyzers when the build enforces code
 * style (IDE0051/IDE0052 unused private members, IDE0060 unused parameter,
 * IDE0005 unnecessary using).
 */

import path from "node:path";
import {
  newDiagnostics,
  type UnusedDiagnostic,
  type UnusedDiagnosticsInput,
  type UnusedDiagnosticsResult,
} from "../../core/adapter.js";

const UNUSED_CODES = "CS0169|CS0414|CS0168|CS0219|CS8321|CS9113|IDE0051|IDE0052|IDE0060|IDE0005";

const WARNING = new RegExp(
  `^\\s*(.+?\\.cs)\\((\\d+),\\d+\\): (?:warning|error) (${UNUSED_CODES}): (.*?)(?: \\[[^\\]]*\\])?\\s*$`,
);

/** Unused-code warnings in `files`, each reported once (the build summary repeats them). */
export function parseDotnetUnused(log: string, files: string[]): UnusedDiagnostic[] {
  const wanted = new Set(files.map((f) => path.resolve(f)));
  const seen = new Set<string>();
  const out: UnusedDiagnostic[] = [];
  for (const line of log.split(/\r?\n/)) {
    const m = WARNING.exec(line);
    if (!m) continue;
    const file = path.resolve(m[1]);
    if (!wanted.has(file)) continue;
    const d = { file, line: Number(m[2]), code: m[3], message: m[4] };
    const key = `${d.file}:${d.line}:${d.code}:${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

export function dotnetUnusedDiagnostics(input: UnusedDiagnosticsInput): UnusedDiagnosticsResult | undefined {
  if (input.buildLog === undefined) return undefined;
  const files = input.changedFiles.filter((f) => f.endsWith(".cs"));
  const current = parseDotnetUnused(input.buildLog, files);
  if (input.baselineBuildLog === undefined) return { diagnostics: current, compared: false };
  const diagnostics = newDiagnostics(current, parseDotnetUnused(input.baselineBuildLog, files));
  return { diagnostics, compared: true };
}
