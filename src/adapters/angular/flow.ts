/**
 * Where a flag's value goes in TypeScript code. For now: renamed imports of a
 * flag registry (`import { FeatureFlags as AppFeatureFlags }`), so code that
 * reads `AppFeatureFlags.X` is checked like `FeatureFlags.X`. Parsed per file,
 * never type-checked.
 */

import fs from "node:fs";
import ts from "typescript";
import type { FlagFlow, FlagRef, ProjectContext } from "../../core/adapter.js";
import type { FlagFlowName } from "../../core/types.js";

export function angularFlow(ctx: ProjectContext, flags: FlagRef[]): FlagFlow {
  const names: FlagFlowName[] = [];
  for (const file of ctx.files) {
    if (!file.endsWith(".ts")) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!/\bas\s/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const statement of sf.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if (!element.propertyName) continue;
        const original = element.propertyName.text;
        const renamed = element.name.text;
        const line = sf.getLineAndCharacterOfPosition(element.getStart(sf)).line + 1;
        for (const { flag, aliases } of flags) {
          for (const alias of aliases) {
            if (!alias.startsWith(`${original}.`)) continue;
            const name = `${renamed}${alias.slice(original.length)}`;
            names.push({ flag, name, kind: "alias", project: ctx.name, file, line });
          }
        }
      }
    }
  }
  return { names, tests: [] };
}
