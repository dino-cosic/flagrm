/**
 * TypeScript "unused" diagnostics for `verify`'s dead-code check: the
 * compiler's own `noUnusedLocals`/`noUnusedParameters` analysis, run in
 * memory on the changed files only, then on their baseline versions so
 * pre-existing findings can be subtracted.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  newDiagnostics,
  type UnusedDiagnostic,
  type UnusedDiagnosticsInput,
  type UnusedDiagnosticsResult,
} from "../../core/adapter.js";

/** "declared but never read/used" (locals, imports, private members, type parameters, destructuring). */
const UNUSED_CODES = new Set([6133, 6138, 6192, 6196, 6198, 6199, 6205]);

const OPTIONS: ts.CompilerOptions = {
  noUnusedLocals: true,
  noUnusedParameters: true,
  experimentalDecorators: true,
  noLib: true,
  noResolve: true,
  types: [],
  target: ts.ScriptTarget.ES2022,
};

function diagnose(files: Array<{ file: string; text: string }>): UnusedDiagnostic[] {
  // Unused-ness is decided per file by the binder, so neither lib files nor the
  // rest of the program are needed; unresolved imports do not matter here.
  // Keyed by the name TypeScript asks for: it turns `\` into `/` (Windows paths).
  const originals = new Map(files.map(({ file }) => [file.replace(/\\/g, "/"), file] as const));
  const sources = new Map(
    files.map(({ file, text }) => {
      const name = file.replace(/\\/g, "/");
      return [name, ts.createSourceFile(name, text, OPTIONS.target!, true)] as const;
    }),
  );
  const host: ts.CompilerHost = {
    getSourceFile: (file) => sources.get(file),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (file) => file,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (file) => sources.has(file),
    readFile: () => undefined,
  };
  const program = ts.createProgram([...sources.keys()], OPTIONS, host);
  const out: UnusedDiagnostic[] = [];
  for (const [name, sf] of sources) {
    const file = originals.get(name) ?? name;
    for (const d of program.getSemanticDiagnostics(sf)) {
      if (!UNUSED_CODES.has(d.code) || d.start === undefined) continue;
      out.push({
        file,
        line: sf.getLineAndCharacterOfPosition(d.start).line + 1,
        code: `TS${d.code}`,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Diagnostics in each file's current text that its baseline text (if any) did not have. */
export function diagnoseUnusedTs(files: Array<{ file: string; text: string; baseline?: string }>): UnusedDiagnostic[] {
  const current = diagnose(files);
  const before = diagnose(
    files.flatMap(({ file, baseline }) => (baseline === undefined ? [] : [{ file, text: baseline }])),
  );
  return newDiagnostics(current, before);
}

export function angularUnusedDiagnostics(input: UnusedDiagnosticsInput): UnusedDiagnosticsResult {
  const files = input.changedFiles
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => ({
      file: path.resolve(file),
      text: fs.readFileSync(file, "utf8"),
      baseline: input.baselineText(file),
    }));
  return { diagnostics: diagnoseUnusedTs(files), compared: true };
}
