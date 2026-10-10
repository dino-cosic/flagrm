/**
 * One hop of a flag's value into a child component: a parent's template
 * binds a holder (`[express]="expressShipping()"`) on an element whose tag is
 * another component's selector, and the child's input of that binding name
 * holds the flag too. Templates are scanned lexically; components are parsed,
 * never type-checked. The child's own bindings are not followed.
 */

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { Holder, TsFile } from "./holders.js";

interface ComponentInfo {
  file: TsFile;
  cls: ts.ClassDeclaration;
  /** Plain element selectors, lower-cased. */
  selectors: string[];
  /** Absolute path of the `templateUrl` file. */
  templateUrl?: string;
  /** The inline `template`. */
  template?: string;
}

const ELEMENT_SELECTOR = /^[a-z][\w-]*$/i;
/** A start tag and its attributes; quoted values may contain `>`. */
const START_TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s"'=<>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
/** `[prop]="expr"` or `[prop]='expr'`; `[attr.x]`, `[class.x]`, `[style.x]` don't match. */
const PROPERTY_BINDING = /\[([\w$]+)\]\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** `h`, `!h`, `h()` or `!h()`. */
const HOLDER_READ = /^!?\s*([A-Za-z_$][\w$]*)(?:\s*\(\s*\))?$/;
const SIGNAL_INPUT = /^(?:input|model)(?:\.required)?$/;

/** The inputs of child components that parents' templates bind one of `holders` to. */
export function childInputs(files: TsFile[], holders: Holder[]): Holder[] {
  const all = components(files);
  const bySelector = new Map<string, ComponentInfo[]>();
  for (const c of all) for (const s of c.selectors) bySelector.set(s, [...(bySelector.get(s) ?? []), c]);

  const out: Holder[] = [];
  for (const parent of all) {
    const bound = new Map<string, Set<string>>();
    for (const h of holders) {
      if (h.cls !== parent.cls || h.kind === "local" || h.ternary || h.ambiguous) continue;
      bound.set(h.name, (bound.get(h.name) ?? new Set<string>()).add(h.flag));
    }
    if (bound.size === 0) continue;
    const template = templateOf(parent)?.replace(/<!--[\s\S]*?-->/g, "");
    if (!template) continue;
    for (const tag of template.matchAll(START_TAG)) {
      const children = bySelector.get(tag[1].toLowerCase());
      if (!children) continue;
      for (const binding of tag[2].matchAll(PROPERTY_BINDING)) {
        const read = HOLDER_READ.exec((binding[2] ?? binding[3]).trim());
        const flags = read ? bound.get(read[1]) : undefined;
        if (!flags) continue;
        for (const child of children) {
          const input = findInput(child, binding[1]);
          if (!input) continue;
          for (const flag of flags) {
            out.push({
              flag,
              name: input.name,
              kind: "field",
              file: child.file.file,
              line: input.line,
              cls: child.cls,
              ...(children.length > 1 ? { ambiguous: true } : {}),
            });
          }
        }
      }
    }
  }
  return out;
}

/** The `@Component` classes of `files`, with their selectors and template. */
function components(files: TsFile[]): ComponentInfo[] {
  const out: ComponentInfo[] = [];
  for (const file of files) {
    if (!file.text.includes("@Component")) continue;
    for (const statement of file.sf.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      for (const decorator of ts.getDecorators(statement) ?? []) {
        const call = decorator.expression;
        if (!ts.isCallExpression(call) || call.expression.getText(file.sf) !== "Component") continue;
        const options = call.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) continue;
        const info: ComponentInfo = { file, cls: statement, selectors: [] };
        for (const prop of options.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isStringLiteralLike(prop.initializer)) continue;
          const key = prop.name.getText(file.sf);
          const value = prop.initializer.text;
          if (key === "selector") {
            info.selectors = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => ELEMENT_SELECTOR.test(s))
              .map((s) => s.toLowerCase());
          } else if (key === "template") {
            info.template = value;
          } else if (key === "templateUrl") {
            info.templateUrl = path.resolve(path.dirname(file.file), value);
          }
        }
        out.push(info);
      }
    }
  }
  return out;
}

function templateOf(c: ComponentInfo): string | undefined {
  if (c.template !== undefined) return c.template;
  if (!c.templateUrl) return undefined;
  try {
    return fs.readFileSync(c.templateUrl, "utf8");
  } catch {
    return undefined;
  }
}

/** The child's member whose binding name (its `alias`, else its own name) is `binding`. */
function findInput(child: ComponentInfo, binding: string): { name: string; line: number } | undefined {
  const { sf } = child.file;
  for (const member of child.cls.members) {
    if (!(ts.isPropertyDeclaration(member) || ts.isSetAccessorDeclaration(member)) || !ts.isIdentifier(member.name)) {
      continue;
    }
    const name = member.name.text;
    const line = sf.getLineAndCharacterOfPosition(member.name.getStart(sf)).line + 1;
    const decorator = (ts.getDecorators(member) ?? [])
      .map((d) => d.expression)
      .find((e): e is ts.CallExpression => ts.isCallExpression(e) && e.expression.getText(sf) === "Input");
    if (decorator) {
      if ((aliasOf(decorator.arguments, true) ?? name) === binding) return { name, line };
      continue;
    }
    const init = ts.isPropertyDeclaration(member) ? member.initializer : undefined;
    if (
      init &&
      ts.isCallExpression(init) &&
      SIGNAL_INPUT.test(init.expression.getText(sf)) &&
      (aliasOf(init.arguments, false) ?? name) === binding
    ) {
      return { name, line };
    }
  }
  return undefined;
}

/**
 * An input's alias: `{ alias: 'x' }` among the arguments, or (for `@Input`
 * only, where a signal input's first argument is its initial value) `'x'`.
 */
function aliasOf(args: readonly ts.Expression[], stringAlias: boolean): string | undefined {
  for (const arg of args) {
    if (stringAlias && ts.isStringLiteralLike(arg)) return arg.text;
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const p of arg.properties) {
      if (
        ts.isPropertyAssignment(p) &&
        ts.isIdentifier(p.name) &&
        p.name.text === "alias" &&
        ts.isStringLiteralLike(p.initializer)
      ) {
        return p.initializer.text;
      }
    }
  }
  return undefined;
}
