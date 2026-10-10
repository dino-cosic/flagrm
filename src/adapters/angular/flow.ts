/**
 * Where a flag's value goes in TypeScript code: renamed imports of a flag
 * registry (`import { FeatureFlags as AppFeatureFlags }`), so `AppFeatureFlags.X`
 * is checked like `FeatureFlags.X`, and the fields, getters, methods and
 * locals holding an evaluation of the flag (`holders.ts`). Each file is parsed
 * at most once, never type-checked.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { FlagFlow, FlagRef, ProjectContext } from "../../core/adapter.js";
import { isTestPath } from "../../core/scan.js";
import type { FlagFlowName } from "../../core/types.js";
import { collectSites, deriveHolders, evaluationMatcher, skipParens, type TsFile } from "./holders.js";

/** A renamed named import: `import { A as B }`, `import type { A as B }`, `import X, { A as B }`. */
const RENAMED_IMPORT = /\bimport\s*(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*\bas\s/;

export function angularFlow(ctx: ProjectContext, flags: FlagRef[], evalMethods: string[]): FlagFlow {
  const files = parseFiles(ctx, evalMethods);
  const names: FlagFlowName[] = files.flatMap((f) => importAliases(ctx, f, flags));
  if (evalMethods.length === 0) return { names, tests: [] };

  const code = files.filter((f) => !f.isTest);
  const evaluates = evaluationMatcher(evalMethods, flagOfArgument(flags, names));
  const holders = deriveHolders(collectSites(code), evaluates);
  for (const h of holders) {
    if (evalMethods.includes(h.name)) continue;
    const same = (n: FlagFlowName) => n.flag === h.flag && n.name === h.name && n.kind === h.kind && n.file === h.file;
    if (names.some(same)) continue;
    names.push({
      flag: h.flag,
      name: h.name,
      kind: h.kind,
      ...(h.ambiguous ? { ambiguous: true } : {}),
      project: ctx.name,
      file: h.file,
      line: h.line,
    });
  }
  return { names, tests: [] };
}

/** The `.ts` files any pass needs, each read and parsed once. */
function parseFiles(ctx: ProjectContext, evalMethods: string[]): TsFile[] {
  const files: TsFile[] = [];
  for (const file of ctx.files) {
    if (!file.endsWith(".ts")) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const wanted =
      RENAMED_IMPORT.test(text) ||
      (evalMethods.length > 0 && (text.includes("@Component") || evalMethods.some((m) => text.includes(m))));
    if (!wanted) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    files.push({ file, text, sf, isTest: isTestPath(path.relative(ctx.root, file)) });
  }
  return files;
}

/** The flag names a renamed import in `f` gives: `AppFeatureFlags.X` for `FeatureFlags.X`. */
function importAliases(ctx: ProjectContext, f: TsFile, flags: FlagRef[]): FlagFlowName[] {
  const names: FlagFlowName[] = [];
  for (const statement of f.sf.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (!element.propertyName) continue;
      const original = element.propertyName.text;
      const renamed = element.name.text;
      const line = f.sf.getLineAndCharacterOfPosition(element.getStart(f.sf)).line + 1;
      for (const { flag, aliases } of flags) {
        for (const alias of aliases) {
          if (!alias.startsWith(`${original}.`)) continue;
          const name = `${renamed}${alias.slice(original.length)}`;
          names.push({ flag, name, kind: "alias", project: ctx.name, file: f.file, line });
        }
      }
    }
  }
  return names;
}

/**
 * The flag an eval call's first argument names: its string literal, one of
 * its qualified names (`FeatureFlags.X`), or an import alias of one declared
 * in the same file (`AppFeatureFlags.X`).
 */
function flagOfArgument(flags: FlagRef[], aliases: FlagFlowName[]) {
  const literals = new Set(flags.map((f) => f.flag));
  const qualified = new Map<string, string>();
  for (const { flag, aliases: names } of flags) {
    for (const name of names) if (!qualified.has(name)) qualified.set(name, flag);
  }
  const imported = new Map<string, Map<string, string>>();
  for (const a of aliases) {
    const inFile = imported.get(a.file) ?? new Map<string, string>();
    inFile.set(a.name, a.flag);
    imported.set(a.file, inFile);
  }
  return (file: TsFile, arg: ts.Expression): string | undefined => {
    const value = skipParens(arg);
    if (ts.isStringLiteralLike(value)) return literals.has(value.text) ? value.text : undefined;
    const text = value.getText(file.sf).replace(/\s+/g, "");
    return qualified.get(text) ?? imported.get(file.file)?.get(text);
  };
}
