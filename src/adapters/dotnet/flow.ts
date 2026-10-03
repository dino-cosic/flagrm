/**
 * Follow a flag's value through C# code: the bool locals, fields and
 * properties that hold `IsEnabled(<flag>)`, the methods that only return it
 * (or a ternary on it), and the parameters it is passed to. Each is a name
 * the removal has to get rid of, and that `verify` should check. Tests that
 * call such a method with a `true`/`false` literal for the parameter are
 * parameterized over the flag.
 *
 * Like the rest of discovery this is lexical (comments and strings masked,
 * brackets matched), not a C# parser: it finds the common shapes and misses
 * unusual ones, which the agent still records with `--name`.
 */

import fs from "node:fs";
import path from "node:path";
import type { FlagFlow, FlagRef, ProjectContext } from "../../core/adapter.js";
import { computeCodeMask, escapeRegExp, isTestPath, methodNamePattern } from "../../core/scan.js";
import { SourceText } from "../../core/source-text.js";
import { matchBracket, toLf } from "../../core/text-utils.js";
import type { FlagFlowName, ParameterizedTest } from "../../core/types.js";

interface CsFile {
  file: string;
  text: string;
  /** 1 where the character is code (not a comment or string). */
  mask: Uint8Array;
  source: SourceText;
  isTest: boolean;
}

/** Keywords that can precede `name(` without it being a declaration or a call of `name`. */
const KEYWORDS = new Set(
  "new return await throw else case in is as yield out ref typeof nameof sizeof default using if while for foreach switch lock catch when var get set init and or not".split(
    " ",
  ),
);

/** A call of a method that evaluates a flag: a configured eval method, or a wrapper method found earlier. */
interface Evaluator {
  pattern: RegExp;
  /** Only calls in this file count (a static wrapper called without its class, from inside it). */
  onlyIn?: string;
  /** The flag the call evaluates: from its first argument, or fixed for a wrapper method. */
  flagOf: (args: string) => string | undefined;
}

/** A value of the flag passed as an argument, waiting for its parameter to be resolved. */
interface FlagArgument {
  flag: string;
  callee: string;
  index: number;
  label?: string;
  /** Called through a receiver (`x.Foo(...)`), so an extension method's `this` parameter comes first. */
  viaDot: boolean;
}

export function dotnetFlow(ctx: ProjectContext, flags: FlagRef[], evalMethods: string[]): FlagFlow {
  const files = readCsFiles(ctx);
  const code = files.filter((f) => !f.isTest);
  const names: FlagFlowName[] = [];
  const args: FlagArgument[] = [];
  const add = (name: Omit<FlagFlowName, "project">) => {
    if (evalMethods.includes(name.name) || KEYWORDS.has(name.name)) return;
    const same = (n: FlagFlowName) =>
      n.flag === name.flag && n.name === name.name && n.kind === name.kind && n.file === name.file;
    if (names.some(same)) return;
    names.push({ ...name, project: ctx.name });
  };

  const declarations = methodDeclarations(code);
  const ternaries = new Set<string>();
  const flagOfArgs = flagMatcher(flags);
  const evaluators: Evaluator[] = evalMethods.length
    ? [
        {
          pattern: new RegExp(`\\b(?:${evalMethods.map(methodNamePattern).join("|")})\\s*(?:<[^<>()]*>)?\\s*\\(`, "g"),
          flagOf: (a) => flagOfArgs(firstArgument(a)),
        },
      ]
    : [];
  // Pass 1: the eval calls. Pass 2: calls of the wrapper methods pass 1 found.
  for (let pass = 0; pass < 2; pass++) {
    for (const f of code) {
      for (const ev of evaluators) {
        if (!ev.onlyIn || ev.onlyIn === f.file) findEvaluations(f, ev, add, args, ternaries);
      }
    }
    // A method returning a ternary on the flag (`? "collections" : "shared folders"`) returns another
    // value, not the flag's: a local holding its result stays after the removal.
    const methods = names.filter((n) => n.kind === "method" && !ternaries.has(n.name));
    if (pass === 1 || methods.length === 0) break;
    evaluators.length = 0;
    for (const m of methods) evaluators.push(...wrapperCalls(m, declarations));
  }
  // An instance method is recorded by its bare name: when another method has the same name, that name
  // would match the other one's calls too.
  for (const n of names) {
    if (n.kind !== "method" || n.name.includes(".")) continue;
    if ((declarations.get(n.name) ?? []).filter((d) => d.hasBody).length > 1) n.ambiguous = true;
  }
  // Locals, fields and properties holding the value, passed on as an argument.
  for (const f of code) {
    for (const n of names.filter(
      (x) => (x.kind === "local" || x.kind === "field" || x.kind === "property") && x.file === f.file,
    )) {
      for (const m of f.text.matchAll(
        new RegExp(`(?<![\\w$.])(?:this\\s*\\.\\s*)?${escapeRegExp(n.name)}(?![\\w$])`, "g"),
      )) {
        if (!f.mask[m.index]) continue;
        const arg = wholeArgument(f, m.index, m.index + m[0].length);
        if (arg) args.push({ flag: n.flag, ...arg });
      }
    }
  }

  // The parameter each argument lands in. Only the callee's name is known, so every declaration of that
  // name with a bool parameter there is a candidate: when they name it differently (`GetName(bool
  // useVfo1Terminology)`, `Organization.GetName(bool includeDomain)`), which one the call reaches is
  // unknown, so each is only suggested and its tests aren't reported.
  const parameters: Array<{ flag: string; method: string; index: number; name: string; extension: boolean }> = [];
  for (const a of args) {
    const candidates: Array<{ d: Declaration; p: Declaration["params"][number] }> = [];
    for (const d of declarations.get(a.callee) ?? []) {
      const offset = a.viaDot && d.extension ? 1 : 0;
      const p = a.label ? d.params.find((x) => x.name === a.label) : d.params[a.index + offset];
      if (p && /^bool\??$/.test(p.type)) candidates.push({ d, p });
    }
    const ambiguous = new Set(candidates.map((c) => c.p.name)).size > 1;
    for (const { d, p } of candidates) {
      add({
        flag: a.flag,
        name: p.name,
        kind: "parameter",
        file: d.file,
        line: d.line,
        ...(ambiguous ? { ambiguous } : {}),
      });
      const index = d.params.indexOf(p);
      if (!ambiguous && !parameters.some((x) => x.method === a.callee && x.index === index)) {
        parameters.push({ flag: a.flag, method: a.callee, index, name: p.name, extension: d.extension });
      }
    }
  }

  const tests: ParameterizedTest[] = [];
  for (const f of files.filter((x) => x.isTest)) {
    for (const p of parameters) {
      for (const m of f.text.matchAll(new RegExp(`\\b${escapeRegExp(p.method)}\\s*(?:<[^<>()]*>)?\\s*\\(`, "g"))) {
        if (!f.mask[m.index]) continue;
        const open = m.index + m[0].length - 1;
        const close = matchBracket(f.text, f.mask, open, "(", ")");
        if (close === -1) continue;
        const list = splitTopLevel(f.text.slice(open + 1, close));
        const viaDot = /\.\s*$/.test(f.text.slice(Math.max(0, m.index - 20), m.index));
        const offset = viaDot && p.extension ? 1 : 0;
        const named = list.find((a) => new RegExp(`^${escapeRegExp(p.name)}\\s*:`).test(a));
        const value = (named ? named.slice(named.indexOf(":") + 1) : list[p.index - offset])?.trim();
        if (value !== "true" && value !== "false") continue;
        tests.push({
          flag: p.flag,
          project: ctx.name,
          file: f.file,
          line: f.source.position(m.index).line,
          method: p.method,
          parameter: p.name,
          value: value === "true",
        });
      }
    }
  }

  return { names, tests };
}

function readCsFiles(ctx: ProjectContext): CsFile[] {
  const out: CsFile[] = [];
  for (const file of ctx.files) {
    if (!file.endsWith(".cs")) continue;
    let text: string;
    try {
      text = toLf(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    out.push({
      file,
      text,
      mask: computeCodeMask(text),
      source: new SourceText(file, text),
      isTest: isTestPath(path.relative(ctx.root, file)),
    });
  }
  return out;
}

/** Which flag an eval call's argument names: its literal (`"NewCheckout"`) or a definition (`FeatureFlags.NewCheckout`). */
function flagMatcher(flags: FlagRef[]): (arg: string) => string | undefined {
  const tests = flags.map((f) => {
    const parts = [`(['"])${escapeRegExp(f.flag)}\\1`];
    for (const alias of f.aliases) {
      parts.push(`(?<![\\w$])${alias.split(".").map(escapeRegExp).join("\\s*\\.\\s*")}(?![\\w$])`);
    }
    return { flag: f.flag, pattern: new RegExp(parts.join("|")) };
  });
  return (arg) => tests.find((t) => t.pattern.test(arg))?.flag;
}

function firstArgument(args: string): string {
  return splitTopLevel(args)[0] ?? "";
}

/** Split an argument or parameter list at its top-level commas. */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let quote: string | undefined;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  if (list.trim()) out.push(list.slice(start));
  return out.map((s) => s.trim());
}

/** The receiver chain and `await` before a call: `await _featureService.` in `await _featureService.IsEnabledAsync(`. */
const RECEIVER = /(?:\bawait\s+)?(?:(?:this|base|@?\w+)(?:\(\))?\s*[?!]?\.\s*)*$/;

/**
 * Each call of `ev` that evaluates a flag, and what its value goes into: a
 * local, field or property assigned only that value, a method returning it
 * (or a ternary on it) and nothing else, or an argument of another call.
 */
function findEvaluations(
  f: CsFile,
  ev: Evaluator,
  add: (name: Omit<FlagFlowName, "project">) => void,
  args: FlagArgument[],
  ternaries: Set<string>,
): void {
  const { text, mask } = f;
  for (const m of text.matchAll(ev.pattern)) {
    if (!mask[m.index]) continue;
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, mask, open, "(", ")");
    if (close === -1) continue;
    const flag = ev.flagOf(text.slice(open + 1, close));
    if (!flag) continue;
    const start = m.index - (RECEIVER.exec(text.slice(Math.max(0, m.index - 200), m.index))?.[0].length ?? 0);
    const line = f.source.position(m.index).line;

    const arg = wholeArgument(f, start, close + 1);
    if (arg) {
      args.push({ flag, ...arg });
      continue;
    }
    const boundary = statementStart(text, mask, start);
    if (boundary === undefined) continue;
    const head = text.slice(boundary + 1, start);
    const next = nextCode(text, mask, close + 1);
    const holdsOnly = text[next] === ";";
    const valueOrTernary = holdsOnly || text[next] === "?";

    let hit: RegExpExecArray | null;
    if (holdsOnly && (hit = /\b(?:var|bool\??)\s+(@?\w+)\s*=\s*$/.exec(head))) {
      const field = /\b(?:private|public|protected|internal|readonly|static)\b/.test(head);
      add({ flag, name: hit[1], kind: field ? "field" : "local", file: f.file, line });
    } else if (holdsOnly && (hit = /(?:^|[\s(])(this\s*\.\s*)?(@?\w+)\s*=\s*$/.exec(head))) {
      const field = Boolean(hit[1]) || hit[2].startsWith("_");
      add({ flag, name: hit[2], kind: field ? "field" : "local", file: f.file, line });
    } else if (holdsOnly && (hit = /\bbool\??\s+(\w+)\s*=>\s*$/.exec(head))) {
      add({ flag, name: hit[1], kind: "property", file: f.file, line });
    } else if (valueOrTernary && (hit = /(\w+)\s*(?:<[^<>()]*>)?\s*\(([^()]*)\)\s*=>\s*$/.exec(head))) {
      const name = methodName(text, mask, boundary, head, hit[1]);
      if (!holdsOnly) ternaries.add(name);
      add({ flag, name, kind: "method", file: f.file, line });
    } else if (valueOrTernary && /^\s*return\s+$/.test(head) && text[boundary] === "{" && onlyStatement(f, close)) {
      const signature = /(\w+)\s*(?:<[^<>()]*>)?\s*\(([^()]*)\)\s*$/.exec(
        text.slice(Math.max(0, boundary - 300), boundary),
      );
      const outer = statementStart(text, mask, boundary);
      if (signature && outer !== undefined) {
        const decl = text.slice(outer + 1, boundary);
        const name = methodName(text, mask, outer, decl, signature[1]);
        if (!holdsOnly) ternaries.add(name);
        add({ flag, name, kind: "method", file: f.file, line });
      }
    }
  }
}

/**
 * How a wrapper method found in pass 1 is called. A static one by
 * `Class.Method(`, or by its bare name inside its own file. An instance one
 * by its name, but only when exactly one method of that name has a body in
 * the project: otherwise `x.Plural()` may be another class's `Plural`.
 */
function wrapperCalls(method: FlagFlowName, declarations: Map<string, Declaration[]>): Evaluator[] {
  const flagOf = () => method.flag;
  const dot = method.name.lastIndexOf(".");
  const simple = method.name.slice(dot + 1);
  if (dot >= 0) {
    const owner = method.name.slice(0, dot);
    return [
      { pattern: new RegExp(`\\b${escapeRegExp(owner)}\\s*\\.\\s*${escapeRegExp(simple)}\\s*\\(`, "g"), flagOf },
      { pattern: new RegExp(`(?<![\\w$.])${escapeRegExp(simple)}\\s*\\(`, "g"), flagOf, onlyIn: method.file },
    ];
  }
  const bodies = (declarations.get(simple) ?? []).filter((d) => d.hasBody);
  if (bodies.length !== 1) return [];
  return [{ pattern: new RegExp(`\\b${escapeRegExp(simple)}\\s*\\(`, "g"), flagOf }];
}

/** A static method is recorded as `Class.Method`, which callers outside the class write; an instance method by name. */
function methodName(text: string, mask: Uint8Array, at: number, declaration: string, name: string): string {
  if (!/\bstatic\b/.test(declaration)) return name;
  let owner: string | undefined;
  for (const m of text.slice(0, at).matchAll(/\b(?:class|struct|record)\s+(\w+)/g)) if (mask[m.index]) owner = m[1];
  return owner ? `${owner}.${name}` : name;
}

/**
 * Whether `[start, end)` is a whole argument of a call: what comes before it
 * up to the enclosing `(` or `,` is at most a `name:` label, and a `,` or `)`
 * follows it. Returns the callee, the argument's position and its label.
 */
function wholeArgument(f: CsFile, start: number, end: number): Omit<FlagArgument, "flag"> | undefined {
  const { text, mask } = f;
  const after = nextCode(text, mask, end);
  if (text[after] !== "," && text[after] !== ")") return undefined;
  let depth = 0;
  let index = 0;
  let edge = -1;
  let open = -1;
  for (let i = start - 1; i >= 0; i--) {
    if (!mask[i]) continue;
    const c = text[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      if (edge === -1) edge = i;
      index++;
    } else if (c === ";" && depth === 0) return undefined;
  }
  if (open === -1 || text[open] !== "(") return undefined;
  const before = text.slice((edge === -1 ? open : edge) + 1, start);
  const label = /^\s*(@?\w+)\s*:\s*$/.exec(before)?.[1];
  if (!label && before.trim()) return undefined;
  const callee = /(@?\w+)\s*(?:<[^<>()]*>)?\s*$/.exec(text.slice(Math.max(0, open - 200), open));
  if (!callee || KEYWORDS.has(callee[1])) return undefined;
  const viaDot = /\.\s*$/.test(text.slice(Math.max(0, open - 200), open - callee[0].length + 1));
  return { callee: callee[1], index, label, viaDot };
}

/** The `;`, `{` or `}` that ends the previous statement, outside brackets; undefined inside an argument list. */
function statementStart(text: string, mask: Uint8Array, from: number): number | undefined {
  let depth = 0;
  for (let i = from - 1; i >= 0; i--) {
    if (!mask[i]) continue;
    const c = text[i];
    if (c === ")" || c === "]") depth++;
    else if (c === "(" || c === "[") {
      if (depth === 0) return undefined;
      depth--;
    } else if (depth === 0 && (c === ";" || c === "{" || c === "}")) return i;
  }
  return -1;
}

/** Index of the next code character that isn't whitespace. */
function nextCode(text: string, mask: Uint8Array, from: number): number {
  let i = from;
  while (i < text.length && (!mask[i] || /\s/.test(text[i]))) i++;
  return i;
}

/** Whether the statement ending after `close` is the last one in its block (`{ return X(...); }`). */
function onlyStatement(f: CsFile, close: number): boolean {
  let i = close + 1;
  while (i < f.text.length && !(f.mask[i] && f.text[i] === ";")) i++;
  return f.text[nextCode(f.text, f.mask, i + 1)] === "}";
}

interface Declaration {
  file: string;
  line: number;
  params: Array<{ type: string; name: string }>;
  /** An extension method: its first parameter is the `this` receiver. */
  extension: boolean;
  /** Has a body (`{` or `=>`): not an interface or abstract member. */
  hasBody: boolean;
}

/** Method and constructor declarations by name, with their parameters. */
function methodDeclarations(files: CsFile[]): Map<string, Declaration[]> {
  const out = new Map<string, Declaration[]>();
  for (const f of files) {
    for (const m of f.text.matchAll(/([\w<>[\]?,.]+)\s+(@?\w+)\s*(?:<[^<>()]*>)?\s*\(/g)) {
      if (!f.mask[m.index] || KEYWORDS.has(m[1]) || KEYWORDS.has(m[2])) continue;
      const open = m.index + m[0].length - 1;
      const close = matchBracket(f.text, f.mask, open, "(", ")");
      if (close === -1) continue;
      const after = /^\s*(\{|=>|;|where\b|:)/.exec(f.text.slice(close + 1, close + 40))?.[1];
      if (!after) continue;
      const raw = splitTopLevel(f.text.slice(open + 1, close));
      const params = raw.map((p) => {
        const plain = p
          .replace(/\[[^\]]*\]/g, "")
          .replace(/=.*$/s, "")
          .replace(/^\s*(?:this|ref|out|in|params|scoped)\s+/, "")
          .trim();
        const word = /(@?\w+)$/.exec(plain);
        return { type: word ? plain.slice(0, word.index).trim() : plain, name: word?.[1] ?? "" };
      });
      const list = out.get(m[2]) ?? [];
      list.push({
        file: f.file,
        line: f.source.position(m.index).line,
        params,
        extension: /^\s*this\s/.test(raw[0] ?? ""),
        hasBody: after !== ";",
      });
      out.set(m[2], list);
    }
  }
  return out;
}
