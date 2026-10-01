/**
 * `flagrm list` discovery for TypeScript sources: flag registries (a flags
 * object or an enum named like `*Flag*`/`*Feature*`/`*Toggle*`) and the
 * boolean flags of Angular `environment*.ts` files.
 *
 * Each file is only parsed, never type-checked, so discovery stays cheap on
 * large workspaces.
 */

import path from "node:path";
import ts from "typescript";
import { configEnvironment } from "../../core/discover.js";
import type { FlagCandidate } from "../../core/types.js";

/** Names of flag registries and of the `features` object in an environment file. */
const REGISTRY_NAME = /flag|feature|toggle/i;

const ENVIRONMENT_FILE = /^environment(?:\..+)?\.ts$/;

/** Strip `as const`, `satisfies T`, parentheses and `Object.freeze(...)` around an initializer. */
function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    return unwrap(node.expression);
  }
  if (ts.isCallExpression(node) && node.expression.getText() === "Object.freeze" && node.arguments.length === 1) {
    return unwrap(node.arguments[0]);
  }
  return node;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function stringValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  const value = unwrap(node);
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
}

/** Candidate flags declared in one TypeScript file. */
export function discoverTypeScript(text: string, file: string, project: string): FlagCandidate[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: FlagCandidate[] = [];
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  for (const statement of sf.statements) {
    if (ts.isEnumDeclaration(statement) && REGISTRY_NAME.test(statement.name.text)) {
      for (const member of statement.members) {
        const name = propertyName(member.name);
        if (name === undefined) continue;
        const flag = member.initializer ? stringValue(member.initializer) : name;
        if (flag === undefined) continue;
        const symbol = `${statement.name.text}.${name}`;
        out.push({ flag, project, source: "constant", file, line: line(member), symbol, symbolKind: "enum-member" });
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer || !REGISTRY_NAME.test(decl.name.text)) continue;
        const obj = unwrap(decl.initializer);
        if (!ts.isObjectLiteralExpression(obj)) continue;
        for (const prop of obj.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const name = propertyName(prop.name);
          const flag = stringValue(prop.initializer);
          if (name === undefined || flag === undefined) continue;
          const symbol = `${decl.name.text}.${name}`;
          out.push({ flag, project, source: "object-key", file, line: line(prop), symbol, symbolKind: "object-key" });
        }
      }
    }
  }

  if (ENVIRONMENT_FILE.test(path.basename(file))) {
    const environment = configEnvironment(file);
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && REGISTRY_NAME.test(propertyName(node.name) ?? "")) {
        const obj = unwrap(node.initializer);
        if (ts.isObjectLiteralExpression(obj)) {
          for (const prop of obj.properties) {
            if (!ts.isPropertyAssignment(prop)) continue;
            const flag = propertyName(prop.name);
            const value = unwrap(prop.initializer).kind;
            if (flag === undefined) continue;
            if (value !== ts.SyntaxKind.TrueKeyword && value !== ts.SyntaxKind.FalseKeyword) continue;
            const state = value === ts.SyntaxKind.TrueKeyword ? "on" : "off";
            out.push({ flag, project, source: "config", file, line: line(prop), environment, state });
          }
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return out;
}
