/** The files that share a component's scope: its `templateUrl` template. Parsed, never type-checked. */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export function componentScopeFiles(file: string): string[] {
  if (!file.endsWith(".ts")) return [];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  if (!text.includes("templateUrl")) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isClassDeclaration(statement)) continue;
    for (const decorator of ts.getDecorators(statement) ?? []) {
      const call = decorator.expression;
      if (!ts.isCallExpression(call) || call.expression.getText(sf) !== "Component") continue;
      const options = call.arguments[0];
      if (!options || !ts.isObjectLiteralExpression(options)) continue;
      for (const prop of options.properties) {
        if (!ts.isPropertyAssignment(prop) || prop.name.getText(sf) !== "templateUrl") continue;
        if (!ts.isStringLiteralLike(prop.initializer)) continue;
        const template = path.resolve(path.dirname(file), prop.initializer.text);
        if (fs.existsSync(template)) out.push(template);
      }
    }
  }
  return out;
}
