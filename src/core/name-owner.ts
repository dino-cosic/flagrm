/**
 * Which flags a name's code reads: where the name is declared or assigned
 * (`name =`, `name:`, `name(...) {`, `Name =>`, `Name {`), and the flag
 * literals and qualified names in what follows, up to the end of that
 * statement or body. Lexical like the rest of discovery (comments and strings
 * masked), so it works for TypeScript and C# alike and misses unusual shapes.
 *
 * `baseline --name` refuses a name that reads only other flags: once
 * recorded, `leftovers` would make the agent delete another flag's code, and
 * a recorded name can't be removed again.
 */

import fs from "node:fs";
import path from "node:path";
import type { FlagRef, Workspace } from "./adapter.js";
import { UsageError } from "./baseline.js";
import { buildInventory } from "./inventory.js";
import { commentSyntax, computeLexicalMask, escapeRegExp, LEX_CODE, LEX_STRING } from "./scan.js";
import { SourceText } from "./source-text.js";
import { toLf } from "./text-utils.js";
import type { RecordedName } from "./types.js";
import { relativePath } from "./util.js";

export interface NameRead {
  /** Absolute file path of the declaration or assignment. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The flags read there, in `flags` order. */
  flags: string[];
}

const MAX_LINES = 20;
const OPEN = "([{";
const CLOSE = ")]}";

/** Every declaration or assignment of `name` in `files` (absolute; every project file when undefined). */
export function nameReads(
  projects: Workspace,
  name: string,
  files: string[] | undefined,
  flags: FlagRef[],
): NameRead[] {
  const only = files && new Set(files);
  const word = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, "g");
  const out: NameRead[] = [];
  const seen = new Set<string>();
  for (const { ctx } of projects) {
    for (const file of ctx.files) {
      if (seen.has(file) || (only && !only.has(file)) || commentSyntax(file) !== "slash") continue;
      seen.add(file);
      let text: string;
      try {
        text = toLf(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      if (!text.includes(name)) continue;
      const mask = computeLexicalMask(text, "slash");
      const source = new SourceText(file, text);
      for (const m of text.matchAll(word)) {
        if (mask[m.index] !== LEX_CODE) continue;
        const after = m.index + name.length;
        if (!isSite(text, mask, m.index, after)) continue;
        const body = text.slice(after, statementEnd(text, mask, after));
        out.push({ file, line: source.position(m.index).line, flags: flagsIn(body, flags) });
      }
    }
  }
  return out;
}

/** A declaration or assignment of the name at `start..after`, not a read, a call, a ternary branch or a case label. */
function isSite(text: string, mask: Uint8Array, start: number, after: number): boolean {
  const before = text.slice(Math.max(0, start - 40), start);
  if (/\?\s*$/.test(before) || /\bcase\s+$/.test(before)) return false;
  let i = after;
  while (i < text.length && /[ \t?!]/.test(text[i])) i++;
  const rest = text.slice(i, i + 3);
  if (rest.startsWith("=>")) return true;
  if (rest.startsWith("=")) return !rest.startsWith("==");
  if (rest.startsWith(":")) return true;
  if (rest.startsWith("{")) return true;
  if (!rest.startsWith("(")) return false;
  // A parameter list, then (after an optional return type, which may hold `|`, `.` or `<>`) a body or
  // `=>`: a method. Anything else is a call: `;`/`,`/`}` or a line break first, or a `)` closing an
  // enclosing bracket (`if (isX()) {`). Arrows and braces inside the call's own brackets don't count.
  let depth = 0;
  for (let j = i; j < Math.min(text.length, i + 400); j++) {
    if (mask[j] !== LEX_CODE) continue;
    const c = text[j];
    if (c === "(") depth++;
    else if (c === ")") {
      if (--depth < 0) return false;
    } else if (depth > 0) continue;
    else if (c === "{") return true;
    else if (c === "=" && text[j + 1] === ">") return true;
    else if (c === ";" || c === "," || c === "}") return false;
    else if (c === "\n") {
      const head = text.slice(j + 1).trimStart();
      return head.startsWith("{") || head.startsWith("=>");
    }
  }
  return false;
}

/** Where the statement or body starting at `from` ends: `;` or `,` at depth 0, a closing bracket below it, or a `{` body's `}`. */
function statementEnd(text: string, mask: Uint8Array, from: number): number {
  let depth = 0;
  let lines = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\n" && ++lines >= MAX_LINES) return i;
    if (mask[i] !== LEX_CODE) continue;
    const c = text[i];
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      depth--;
      if (depth < 0) return i;
      if (depth === 0 && c === "}") return i + 1;
    } else if (depth === 0 && (c === ";" || c === ",")) return i;
  }
  return text.length;
}

/** The flags whose literal (quoted) or qualified name (in code) occurs in `body`. */
function flagsIn(body: string, flags: FlagRef[]): string[] {
  const mask = computeLexicalMask(body, "slash");
  return flags
    .filter(({ flag, aliases }) => {
      for (const m of body.matchAll(new RegExp(`(['"\`])${escapeRegExp(flag)}\\1`, "g"))) {
        if (mask[m.index] === LEX_STRING) return true;
      }
      return aliases.some((alias) => {
        const pattern = alias.split(".").map(escapeRegExp).join("\\s*\\.\\s*");
        for (const m of body.matchAll(new RegExp(`(?<![\\w$])${pattern}(?![\\w$])`, "g"))) {
          if (mask[m.index] === LEX_CODE) return true;
        }
        return false;
      });
    })
    .map((f) => f.flag);
}

/** Throw a {@link UsageError} for the first agent name whose code reads only flags other than `flag`. */
export async function assertOwnNames(
  root: string,
  projects: Workspace,
  flag: string,
  names: RecordedName[],
): Promise<void> {
  if (names.length === 0) return;
  const inventory = (await buildInventory(projects)).flags;
  const refs: FlagRef[] = inventory.map((e) => ({ flag: e.flag, aliases: e.definitions.map((d) => d.name) }));
  if (!refs.some((r) => r.flag === flag)) refs.push({ flag, aliases: [] });
  for (const name of [...new Set(names.map((n) => n.name))]) {
    const entries = names.filter((n) => n.name === name);
    const files = entries.every((n) => n.file) ? entries.map((n) => path.resolve(root, n.file as string)) : undefined;
    const sites = nameReads(projects, name, files, refs);
    if (sites.some((s) => s.flags.includes(flag))) continue;
    const foreign = sites.find((s) => s.flags.length > 0);
    if (!foreign) continue;
    throw new UsageError(
      `"${name}" reads ${foreign.flags.join(", ")}, not ${flag} (${relativePath(root, foreign.file)}:${foreign.line}); ` +
        "not recorded. Record only names this flag's value goes through.",
    );
  }
}
