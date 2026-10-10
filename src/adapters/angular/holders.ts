/**
 * The names a flag's value is held in: fields, getters, parameterless
 * methods and locals whose value is an evaluation of the flag (or its
 * negation), and those whose value is such a name of the same class or
 * function. A getter or method returning a ternary on an evaluation is
 * recorded but not followed: it holds the ternary's value, not the flag's.
 * Parsed, never type-checked.
 */

import ts from "typescript";

/** A `.ts` file parsed once and shared by the flow passes. */
export interface TsFile {
  /** Absolute path. */
  file: string;
  text: string;
  sf: ts.SourceFile;
  /** A test file (`*.spec.ts`): only its import aliases are followed. */
  isTest: boolean;
}

/** A name holding a flag's value. */
export interface Holder {
  flag: string;
  name: string;
  kind: "field" | "property" | "method" | "local";
  /** Absolute path. */
  file: string;
  /** 1-based. */
  line: number;
  /** The class a field, getter or method belongs to (a local's enclosing class). */
  cls?: ts.ClassLikeDeclaration;
  /** The function a local belongs to. */
  fn?: ts.Node;
  /** Returns a ternary on the flag: recorded, but neither followed nor bound. */
  ternary?: boolean;
  /** An input of a component whose selector another component declares too: never recorded. */
  ambiguous?: boolean;
}

/** The flag `expr` evaluates, when it is an evaluation. */
export type Evaluates = (file: TsFile, expr: ts.Expression) => string | undefined;

/** Where a holder can be declared, and the expression its value comes from. */
export interface Site {
  file: TsFile;
  name: string;
  kind: Holder["kind"];
  line: number;
  /** The value, or a ternary's condition. */
  expr: ts.Expression;
  ternary: boolean;
  cls?: ts.ClassLikeDeclaration;
  fn?: ts.Node;
}

export function skipParens(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** `expr` without parentheses and leading `!`s. */
export function skipNot(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) e = e.operand;
    else return e;
  }
}

/**
 * An evaluation: a call of a configured eval method, by the last name of its
 * callee (`a.b.isFeatureFlagEnabled`), whose first argument names the flag;
 * parentheses and `!` around it are allowed.
 */
export function evaluationMatcher(
  evalMethods: string[],
  flagOfArgument: (file: TsFile, arg: ts.Expression) => string | undefined,
): Evaluates {
  return (file, expr) => {
    const e = skipNot(expr);
    if (!ts.isCallExpression(e) || e.arguments.length === 0) return undefined;
    const callee = skipParens(e.expression);
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : undefined;
    if (!name || !evalMethods.includes(name)) return undefined;
    return flagOfArgument(file, e.arguments[0]);
  };
}

/**
 * Every place a holder can be declared: a property with an initializer, a
 * `this.x = …` statement, a getter or parameterless method whose body is a
 * single `return`, a `const`/`let` in a function.
 */
export function collectSites(files: TsFile[]): Site[] {
  const sites: Site[] = [];
  for (const file of files) {
    const { sf } = file;
    const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const visit = (node: ts.Node, cls: ts.ClassLikeDeclaration | undefined, fn: ts.Node | undefined): void => {
      if (cls && ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        sites.push({
          file,
          name: node.name.text,
          kind: "field",
          line: lineOf(node.name),
          expr: node.initializer,
          ternary: false,
          cls,
        });
      } else if (
        cls &&
        ts.isExpressionStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.expression.left) &&
        node.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isIdentifier(node.expression.left.name)
      ) {
        const { left, right } = node.expression;
        sites.push({ file, name: left.name.text, kind: "field", line: lineOf(node), expr: right, ternary: false, cls });
      } else if (
        cls &&
        (ts.isGetAccessorDeclaration(node) || (ts.isMethodDeclaration(node) && node.parameters.length === 0)) &&
        ts.isIdentifier(node.name) &&
        node.body?.statements.length === 1
      ) {
        const only = node.body.statements[0];
        if (ts.isReturnStatement(only) && only.expression) {
          const kind = ts.isGetAccessorDeclaration(node) ? "property" : "method";
          const value = skipParens(only.expression);
          const base = { file, name: node.name.text, kind, line: lineOf(node.name), cls } as const;
          if (ts.isConditionalExpression(value)) sites.push({ ...base, expr: value.condition, ternary: true });
          else sites.push({ ...base, expr: only.expression, ternary: false });
        }
      } else if (
        fn &&
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)
      ) {
        sites.push({
          file,
          name: node.name.text,
          kind: "local",
          line: lineOf(node.name),
          expr: node.initializer,
          ternary: false,
          cls,
          fn,
        });
      }
      const nextCls = ts.isClassLike(node) ? node : cls;
      const nextFn = ts.isFunctionLike(node) ? node : fn;
      ts.forEachChild(node, (child) => visit(child, nextCls, nextFn));
    };
    visit(sf, undefined, undefined);
  }
  return sites;
}

/**
 * The holders among `sites`, repeated until nothing new: a site whose value
 * is an evaluation, or a read of a holder of its class (`this.x`, `!this.x`,
 * `this.x()`) or, for a local, of a local of its function (`x`, `!x`, `x()`).
 * `seeds` (a child component's inputs) are holders from the start.
 */
export function deriveHolders(sites: Site[], evaluates: Evaluates, seeds: Holder[] = []): Holder[] {
  type Scopes = Map<ts.Node, Map<string, Set<string>>>;
  const holders: Holder[] = [];
  const members: Scopes = new Map();
  const locals: Scopes = new Map();
  const index = (scopes: Scopes, scope: ts.Node, name: string, flag: string) => {
    const names = scopes.get(scope) ?? new Map<string, Set<string>>();
    scopes.set(scope, names);
    const flags = names.get(name) ?? new Set<string>();
    names.set(name, flags);
    flags.add(flag);
  };
  const add = (h: Holder): boolean => {
    const same = (o: Holder) =>
      o.flag === h.flag && o.name === h.name && o.kind === h.kind && o.cls === h.cls && o.fn === h.fn;
    if (holders.some(same)) return false;
    holders.push(h);
    if (h.ternary || h.ambiguous) return true;
    if (h.kind === "local") {
      if (h.fn) index(locals, h.fn, h.name, h.flag);
    } else if (h.cls) {
      index(members, h.cls, h.name, h.flag);
    }
    return true;
  };
  const flagsOf = (site: Site): string[] => {
    const flag = evaluates(site.file, site.expr);
    if (flag) return [flag];
    if (site.ternary) return [];
    let read = skipNot(site.expr);
    if (ts.isCallExpression(read) && read.arguments.length === 0) read = skipParens(read.expression);
    if (ts.isPropertyAccessExpression(read) && read.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return [...((site.cls && members.get(site.cls)?.get(read.name.text)) ?? [])];
    }
    if (ts.isIdentifier(read)) return [...((site.fn && locals.get(site.fn)?.get(read.text)) ?? [])];
    return [];
  };

  for (const seed of seeds) add(seed);
  for (let changed = true; changed; ) {
    changed = false;
    for (const site of sites) {
      for (const flag of flagsOf(site)) {
        const holder: Holder = {
          flag,
          name: site.name,
          kind: site.kind,
          file: site.file.file,
          line: site.line,
          cls: site.cls,
        };
        if (site.kind === "local") holder.fn = site.fn;
        if (site.ternary) holder.ternary = true;
        if (add(holder)) changed = true;
      }
    }
  }
  return holders;
}
