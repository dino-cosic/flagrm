import fs from "node:fs";
import path from "node:path";
import type { ProjectContext } from "./adapter.js";
import {
  commentMaskFor,
  commentSyntax,
  computeLexicalMask,
  escapeRegExp,
  isKeyValueConfig,
  isTestPath,
  LEX_COMMENT,
  LEX_STRING,
} from "./scan.js";
import { SourceText } from "./source-text.js";
import { toLf } from "./text-utils.js";

/** A direct mention of a flag in code. */
export interface Mention {
  project: string;
  /** Absolute file path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The string literal's content, or the alias with whitespace removed (`FLAGS.newCheckout`). */
  token: string;
  kind: "literal" | "alias";
  isTest: boolean;
  /** An alias inside a comment (only with `comments: true`). */
  inComment: boolean;
  snippet: string;
}

/**
 * Find, in one pass per file, every string literal equal to one of
 * `literals` and every qualified name in `aliases` (`FLAGS.newCheckout`,
 * also inside `nameof(...)` or a longer chain). An alias followed by `(` is a
 * call of something else with the same name, never a use of a constant.
 * Comments and config (`.json`) files are skipped; with `comments: true`,
 * aliases inside comments (`<see cref="FeatureFlags.NewCheckout"/>`) are
 * returned too, marked `inComment`. A file shared by two projects is reported
 * once, for the first.
 */
export function findMentions(
  projects: ProjectContext[],
  literals: string[],
  aliases: string[],
  options: { comments?: boolean } = {},
): Mention[] {
  const alternation = (keys: string[], toPattern: (key: string) => string) =>
    [...new Set(keys)]
      .sort((a, b) => b.length - a.length)
      .map(toPattern)
      .join("|");
  const parts: string[] = [];
  if (literals.length) parts.push(`(['"\`])(${alternation(literals, escapeRegExp)})\\1`);
  if (aliases.length) {
    const alias = alternation(aliases, (name) => name.split(".").map(escapeRegExp).join("\\s*\\.\\s*"));
    parts.push(`(?<![\\w$])(${alias})(?![\\w$])(?!\\s*\\()`);
  }
  if (parts.length === 0) return [];
  const pattern = new RegExp(parts.join("|"), "g");
  // Group numbers: literal quote/content are 1/2 when present; the alias group comes last.
  const literalGroup = literals.length ? 2 : -1;
  const aliasGroup = literals.length ? 3 : 1;

  const mentions: Mention[] = [];
  const seen = new Set<string>();
  for (const ctx of projects) {
    for (const file of ctx.files) {
      if (seen.has(file) || file.endsWith(".json")) continue;
      seen.add(file);
      let text: string;
      try {
        text = toLf(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0; // matchAll starts from the regex's lastIndex
      const source = new SourceText(file, text);
      const mask = commentMaskFor(file, text);
      const isTest = isTestPath(path.relative(ctx.root, file));
      for (const m of text.matchAll(pattern)) {
        const literal = literalGroup > 0 ? m[literalGroup] : undefined;
        const inComment = mask !== null && mask[m.index] === 0;
        if (inComment && (!options.comments || literal !== undefined)) continue;
        mentions.push({
          project: ctx.name,
          file,
          line: source.position(m.index).line,
          token: literal ?? m[aliasGroup].replace(/\s+/g, ""),
          kind: literal !== undefined ? "literal" : "alias",
          isTest,
          inComment,
          snippet: source.snippet(m.index),
        });
      }
    }
  }
  return mentions;
}

/** A whole-word use of an identifier (see {@link findIdentifiers}). */
export interface IdentifierHit {
  project: string;
  /** Absolute file path. */
  file: string;
  /** 1-based line number. */
  line: number;
  token: string;
  inComment: boolean;
  /** The name is a `key:` / `key=` of a YAML, TOML, properties or `.env` file: a configured flag, not code. */
  isConfigKey: boolean;
}

/** What may come before a key on its line: indentation, a YAML list `- `, `export `, dotted parents (`features.`). */
const CONFIG_KEY_HEAD = /^[ \t]*(?:-[ \t]+)?(?:export[ \t]+)?(?:[\w-]+\.)*$/;
/** What follows a key in a key/value file: `:` and whitespace (YAML), or `=` but not `==`. */
const CONFIG_KEY_TAIL = /^[ \t]*(?::(?=\s|$)|=(?!=))/;

/**
 * Find every whole-word use of `names` (calls included, unlike aliases in
 * {@link findMentions}), skipping string literals. Uses in comments are
 * returned marked `inComment`. Config (`.json`) files are skipped. A file
 * shared by two projects is reported once, for the first.
 *
 * `configPaths` are .NET configuration paths (`FeatureManagement__NewCheckout`
 * environment variables, `FeatureManagement:NewCheckout` keys), matched in the
 * same pass: ignoring case, as .NET configuration does, inside strings and
 * `launchSettings.json` too, and before a deeper `__Section`. Other `.json`
 * files are never read.
 */
export function findIdentifiers(
  projects: ProjectContext[],
  names: string[],
  configPaths: string[] = [],
): IdentifierHit[] {
  const alternation = (list: string[], toPattern: (name: string) => string) =>
    [...new Set(list)]
      .sort((a, b) => b.length - a.length)
      .map(toPattern)
      .join("|");
  const branches = [
    names.length ? `(?<name>${alternation(names, escapeRegExp)})(?![\\w$])` : "",
    configPaths.length ? `(?<path>${alternation(configPaths, caseInsensitivePattern)})(?!(?!__)[\\w$])` : "",
  ].filter(Boolean);
  if (branches.length === 0) return [];
  const pattern = new RegExp(`(?<![\\w$])(?:${branches.join("|")})`, "g");
  const hits: IdentifierHit[] = [];
  const seen = new Set<string>();
  for (const ctx of projects) {
    for (const file of ctx.files) {
      const json = file.endsWith(".json");
      // Of the `.json` files, only launchSettings.json sets environment variables.
      if (seen.has(file) || (json && (configPaths.length === 0 || path.basename(file) !== "launchSettings.json")))
        continue;
      seen.add(file);
      let text: string;
      try {
        text = toLf(fs.readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      pattern.lastIndex = 0;
      if (!pattern.test(text)) continue;
      pattern.lastIndex = 0;
      const keyValue = isKeyValueConfig(file);
      const syntax = commentSyntax(file);
      const mask = syntax ? computeLexicalMask(text, syntax) : null;
      const source = new SourceText(file, text);
      for (const m of text.matchAll(pattern)) {
        const isPath = m.groups?.path !== undefined;
        const cls = mask ? mask[m.index] : 0;
        if (!isPath && (json || cls === LEX_STRING)) continue;
        const end = m.index + m[0].length;
        hits.push({
          project: ctx.name,
          file,
          line: source.position(m.index).line,
          token: m[0],
          inComment: cls === LEX_COMMENT,
          isConfigKey:
            keyValue &&
            CONFIG_KEY_HEAD.test(text.slice(text.lastIndexOf("\n", m.index - 1) + 1, m.index)) &&
            CONFIG_KEY_TAIL.test(text.slice(end, end + 80)),
        });
      }
    }
  }
  return hits;
}

/** `name` as a regex source that matches it in any letter case (`[fF][eE]...`). */
function caseInsensitivePattern(name: string): string {
  return [...name]
    .map((c) => (c.toLowerCase() === c.toUpperCase() ? escapeRegExp(c) : `[${c.toLowerCase()}${c.toUpperCase()}]`))
    .join("");
}
