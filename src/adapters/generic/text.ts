/**
 * Language-agnostic text helpers for the generic adapter: config-file
 * detection, eval-call patterns, `NAME = "flag"` declarations and paren
 * matching, all skipping comments with a per-extension lexical mask.
 */

import path from "node:path";
import { commentSyntax, computeLexicalMask, LEX_CODE, methodNamePattern } from "../../core/scan.js";

const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".properties", ".ini", ".env"]);

/** Configuration files: every mention of the flag in one is a `config` site. */
export function isConfigFile(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  return CONFIG_EXTENSIONS.has(path.extname(base)) || base === ".env" || base.startsWith(".env.");
}

/** Code/comment/string classes per character, or null when the file's comment syntax is unknown (all code). */
export function lexicalMask(file: string, text: string): Uint8Array | null {
  const syntax = commentSyntax(file);
  return syntax ? computeLexicalMask(text, syntax) : null;
}

/** `(?<![\w$])(?:IsEnabled|...)\s*\(` for the configured eval methods, or undefined when there are none. */
export function evalCallPattern(methods: string[]): RegExp | undefined {
  if (methods.length === 0) return undefined;
  return new RegExp(`(?<![\\w$])(?:${methods.map(methodNamePattern).join("|")})\\s*\\(`, "g");
}

/** Declaration keywords, modifiers and built-in string types that are never the declared name. */
const NOT_A_NAME = new Set([
  "const",
  "let",
  "var",
  "val",
  "final",
  "static",
  "public",
  "private",
  "protected",
  "internal",
  "readonly",
  "export",
  "pub",
  "mut",
  "my",
  "our",
  "local",
  "string",
  "String",
  "str",
]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The name a string literal starting at `quote` is assigned to, on the same
 * line: `X = "flag"`, `X := "flag"`, `const X string = "flag"`,
 * `static final String X = "flag"`, `X: str = "flag"`. Undefined for
 * comparisons, keyword arguments, member assignments (`self.x = ...`) and
 * anything else that isn't a plain declaration. Go writes the type after the
 * name, so in `.go` files the first identifier wins, elsewhere the last.
 */
export function declaredName(text: string, quote: number, file: string): { name: string; start: number } | undefined {
  let eq = quote - 1;
  while (eq >= 0 && (text[eq] === " " || text[eq] === "\t")) eq--;
  if (text[eq] !== "=" || /[=!<>+\-*/%&|^~]/.test(text[eq - 1] ?? "")) return undefined;
  const lineStart = text.lastIndexOf("\n", eq - 1) + 1;
  let prefix = text.slice(lineStart, eq);
  if (prefix.endsWith(":")) prefix = prefix.slice(0, -1);
  const count = (c: string) => prefix.split(c).length - 1;
  if (count("(") > count(")") || count("[") > count("]")) return undefined;
  // A type annotation (`X: str`, `X: &'static str`).
  prefix = prefix.replace(/:\s*[&\w$.<>[\], ']+$/, "");

  const tokens = [...prefix.matchAll(/[^\s,;{}]+/g)];
  if (tokens.length === 0 || !IDENTIFIER.test(tokens[tokens.length - 1][0])) return undefined;
  const names = tokens.filter((t) => !NOT_A_NAME.has(t[0]));
  if (names.length === 0 || !names.every((t) => IDENTIFIER.test(t[0]))) return undefined;
  const pick = file.endsWith(".go") ? names[0] : names[names.length - 1];
  return { name: pick[0], start: lineStart + pick.index };
}

/** Index of the `)` matching the `(` at `open`, skipping strings and comments; -1 when unbalanced. */
export function closingParen(text: string, mask: Uint8Array | null, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (mask && mask[i] !== LEX_CODE) continue;
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}
