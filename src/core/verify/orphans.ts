/**
 * Code the removal orphaned without a compiler noticing: a method, property
 * or class whose last reference was in the deleted OFF path is still
 * declared, and a public or internal member gets no "unused" diagnostic.
 *
 * Lexical: an identifier whose count went down in a changed code file, now
 * found exactly once across the projects' files (its declaration) and more
 * than once at the baseline. Comments don't count as references; strings,
 * templates, Razor views and config files do (DI by name, interpolation,
 * Angular bindings, options bound from appsettings), so a hit is a warning.
 */

import fs from "node:fs";
import path from "node:path";
import { fileAt } from "../git.js";
import { commentSyntax, computeLexicalMask, escapeRegExp, LEX_COMMENT } from "../scan.js";
import { SourceText } from "../source-text.js";
import type { CheckFinding } from "../types.js";
import type { VerifyContext } from "./context.js";

/** Files whose identifiers can be declarations the removal orphaned. */
const CODE_FILE = /\.(cs|ts|tsx|js|jsx|mjs|cjs|go|java|kt)$/;

/** Identifiers of 4+ characters: shorter ones (`id`, `Run`) are too common to mean anything here. */
const IDENT = /[A-Za-z_]\w{3,}/g;

/**
 * Keywords and built-in type names (C#, TypeScript/JavaScript, Go, Java,
 * Kotlin) of 4+ characters: removing one can leave a single one in the
 * project, which is no declaration.
 */
const KEYWORDS = new Set(
  (
    "true false null this base void self super class struct record interface enum namespace package import " +
    "export from default extends implements public private protected internal static readonly const final " +
    "abstract virtual override sealed async await yield return throw throws break continue switch case else " +
    "while foreach using lock fixed unsafe checked unchecked params where when select func defer chan range " +
    "type typeof instanceof keyof infer declare module require function constructor delete void never unknown " +
    "string bool boolean char byte short long float double decimal object dynamic number bigint symbol " +
    "Task Void Boolean String Object Unit init operator implicit explicit event delegate goto sizeof stackalloc " +
    "volatile extern partial global nameof value get set add remove inline data sealed open lateinit companion"
  ).split(" "),
);

const MODIFIERS =
  "public|private|protected|internal|static|readonly|virtual|override|abstract|sealed|async|partial|const|extern|" +
  "unsafe|required|new|final|open|suspend|inline|lateinit|declare|export|default|get|set|accessor";

/** Words that start a statement, not a declaration's type (`return Foo;`, `await Bar();`). */
const STATEMENT = new Set([
  "return",
  "await",
  "throw",
  "yield",
  "else",
  "case",
  "goto",
  "using",
  "import",
  "package",
  "namespace",
]);

/**
 * Whether `line` declares `name`, by the shape of declarations in the file's
 * language: what is left of an orphan is its declaration, while the last use
 * of a library member (`mock.Setup(...)`), an object key or an import is not.
 */
export function declares(file: string, line: string, name: string): boolean {
  const n = escapeRegExp(name);
  if (/\.(cs|java|kt)$/.test(file)) {
    if (new RegExp(`\\b(class|interface|record|struct|enum|object|fun|val|var)\\s+${n}\\b`).test(line)) return true;
    const member = new RegExp(
      `^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:(?:${MODIFIERS})\\s+)*([\\w.?<>\\[\\],]+)\\s+${n}\\s*(?:<[^>]*>)?\\s*(?:\\(|\\{|=>|=|;)`,
    ).exec(line);
    return Boolean(member && !STATEMENT.has(member[1]));
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) {
    const mods = `(?:(?:${MODIFIERS})\\s+)`;
    return [
      new RegExp(`\\b(?:function\\*?|class|interface|enum|type|const|let|var|namespace)\\s+${n}\\b`),
      new RegExp(`^\\s*${mods}+${n}\\s*[?!]?\\s*(?:\\(|=|:|<)`),
      new RegExp(`^\\s*${n}\\s*[?!]?\\s*=(?![=>])`),
      new RegExp(`^\\s*${n}\\s*[?!]?\\s*:[^,]*;\\s*$`),
      new RegExp(`^\\s*${n}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^{;=]+)?\\{\\s*$`),
    ].some((re) => re.test(line));
  }
  if (file.endsWith(".go")) {
    return new RegExp(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${n}\\s*[([]|\\b(?:type|var|const)\\s+${n}\\b`).test(line);
  }
  return false;
}

/** At most this many findings: the first ones show the pattern. */
const MAX = 20;

interface Occurrences {
  count: number;
  /** Offset of the first occurrence. */
  first: number;
}

/** Each identifier's occurrences outside comments (`only`: just these identifiers). */
function occurrences(file: string, text: string, only?: Set<string>): Map<string, Occurrences> {
  const syntax = commentSyntax(file);
  const mask = syntax ? computeLexicalMask(text, syntax) : undefined;
  const out = new Map<string, Occurrences>();
  for (const m of text.matchAll(IDENT)) {
    if (only && !only.has(m[0])) continue;
    if (mask && mask[m.index] === LEX_COMMENT) continue;
    const seen = out.get(m[0]);
    if (seen) seen.count++;
    else out.set(m[0], { count: 1, first: m.index });
  }
  return out;
}

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function add(totals: Map<string, number>, counts: Map<string, Occurrences>): void {
  for (const [name, { count }] of counts) totals.set(name, (totals.get(name) ?? 0) + count);
}

export function orphanFindings(v: VerifyContext): CheckFinding[] {
  const sha = v.baseline.git.sha;
  if (!sha || !v.changedFiles) return [];
  const projectFiles = new Map<string, string>();
  for (const { ctx } of v.projects)
    for (const file of ctx.files) if (!projectFiles.has(file)) projectFiles.set(file, ctx.name);
  const roots = v.projects.map(({ ctx }) => ctx.root);
  const inProject = (file: string) =>
    projectFiles.has(file) || (!fs.existsSync(file) && roots.some((r) => !path.relative(r, file).startsWith("..")));
  const changed = v.changedFiles.map((rel) => path.join(v.root, rel)).filter(inProject);
  const recorded = new Set(v.baseline.names.map((n) => n.name));

  // Counts in the changed files then and now; unchanged files count the same both times.
  const before = new Map<string, number>();
  const nowInChanged = new Map<string, number>();
  const candidates = new Set<string>();
  for (const file of changed) {
    const was = occurrences(file, fileAt(v.root, sha, path.relative(v.root, file)) ?? "");
    const text = read(file);
    const is = text === undefined ? new Map<string, Occurrences>() : occurrences(file, text);
    add(before, was);
    add(nowInChanged, is);
    if (!CODE_FILE.test(file)) continue;
    for (const [name, { count }] of was) {
      if (count > (is.get(name)?.count ?? 0) && !recorded.has(name) && !KEYWORDS.has(name)) candidates.add(name);
    }
  }
  if (candidates.size === 0) return [];

  const now = new Map<string, number>();
  const where = new Map<string, { file: string; offset: number; text: string; project: string }>();
  for (const [file, project] of projectFiles) {
    const text = read(file);
    if (text === undefined) continue;
    const counts = occurrences(file, text, candidates);
    add(now, counts);
    for (const [name, { first }] of counts)
      if (!where.has(name)) where.set(name, { file, offset: first, text, project });
  }

  const findings: CheckFinding[] = [];
  for (const name of [...candidates].sort()) {
    const total = now.get(name) ?? 0;
    const wasTotal = total - (nowInChanged.get(name) ?? 0) + (before.get(name) ?? 0);
    const at = where.get(name);
    if (total !== 1 || wasTotal < 2 || !at) continue;
    const source = new SourceText(at.file, at.text);
    if (!declares(at.file, source.snippet(at.offset), name)) continue;
    findings.push({
      severity: "warn",
      message: `${name} is now referenced only where it is declared: delete it if only the OFF path used it`,
      project: at.project,
      file: at.file,
      line: source.position(at.offset).line,
    });
    if (findings.length === MAX) break;
  }
  return findings;
}
