/**
 * Best-effort discovery of *candidate* feature flag names, for `flagrm list`.
 *
 * This is a UX aid: false negatives (a flag it misses) are fine — the agent
 * can still remove a flag by name. False positives are mildly annoying but
 * harmless since nothing is written. So the heuristics here are intentionally
 * simpler/looser than the scan code path.
 */

import path from "node:path";
import {
  type ClassifyContext,
  computeCodeMask,
  computeCommentMask,
  computeLexicalMask,
  escapeRegExp,
  LEX_COMMENT,
  LEX_STRING,
  methodNamePattern,
} from "./scan.js";
import { SourceText } from "./source-text.js";
import { matchBracket } from "./text-utils.js";
import type { ConfigState, FlagCandidate } from "./types.js";

/** The configuration section of Microsoft.FeatureManagement flags. */
export const FEATURE_MANAGEMENT_SECTION = "FeatureManagement";

/**
 * Find keys declared directly inside a top-level `"FeatureManagement": { ... }`
 * object in an appsettings*.json file (Microsoft.FeatureManagement convention).
 * Keys nested inside an individual flag's own filter config (e.g. `EnabledFor`)
 * are not candidates — only the flag names themselves are.
 */
export function findFeatureManagementKeys(text: string): Array<{ key: string; index: number }> {
  const out: Array<{ key: string; index: number }> = [];
  const mask = computeLexicalMask(text, "slash");
  let depth = 0;
  const containerKeyAtDepth: (string | null)[] = [null];
  let pendingKey: string | null = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (mask[i] === LEX_COMMENT) {
      i++;
      continue;
    }
    if (mask[i] === LEX_STRING) {
      const start = i;
      while (i < text.length && mask[i] === LEX_STRING) i++;
      const value = text.slice(start + 1, i - 1);
      let j = i;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === ":") {
        pendingKey = value;
        if (containerKeyAtDepth[depth] === FEATURE_MANAGEMENT_SECTION) out.push({ key: value, index: start });
      }
      continue;
    }
    if (c === "{" || c === "[") {
      containerKeyAtDepth[depth + 1] = c === "{" ? pendingKey : null;
      depth++;
      pendingKey = null;
    } else if (c === "}" || c === "]") {
      containerKeyAtDepth.length = depth;
      depth = Math.max(0, depth - 1);
    }
    i++;
  }
  return out;
}

/**
 * The environment a config file configures, from its name: `default` for the
 * base file, otherwise the suffix (`appsettings.Development.json` →
 * `Development`, `environment.prod.ts` → `prod`).
 */
export function configEnvironment(file: string): string {
  const m = /^(?:appsettings|environment)\.(.+)\.(?:json|ts)$/i.exec(path.basename(file));
  return m ? m[1] : "default";
}

/** Microsoft.FeatureManagement filter that turns a flag on unconditionally. */
const ALWAYS_ON = "AlwaysOn";

/** The configured state of each key in an appsettings file's `FeatureManagement` section. */
function featureManagementStates(text: string): Map<string, { state: ConfigState; filters?: string[] }> {
  const states = new Map<string, { state: ConfigState; filters?: string[] }>();
  let section: unknown;
  try {
    section = (parseJsonc(text) as Record<string, unknown> | null)?.[FEATURE_MANAGEMENT_SECTION];
  } catch {
    return states;
  }
  if (!section || typeof section !== "object") return states;
  for (const [key, value] of Object.entries(section)) {
    // .NET configuration binds the strings "true"/"false" like the booleans.
    if (typeof value === "boolean" || value === "true" || value === "false") {
      states.set(key, { state: value === true || value === "true" ? "on" : "off" });
      continue;
    }
    if (!value || typeof value !== "object") {
      states.set(key, { state: "unknown" });
      continue;
    }
    // A flag object without filters is never enabled.
    const enabledFor = (value as { EnabledFor?: unknown }).EnabledFor;
    if (!Array.isArray(enabledFor)) {
      states.set(key, { state: enabledFor === undefined ? "off" : "unknown" });
      continue;
    }
    const filters = enabledFor.map((f) => String((f as { Name?: unknown } | null)?.Name ?? "")).filter(Boolean);
    if (filters.length === 0) states.set(key, { state: "off" });
    else if (filters.includes(ALWAYS_ON)) states.set(key, { state: "on" });
    else states.set(key, { state: "conditional", filters });
  }
  return states;
}

/** `JSON.parse` for appsettings-style JSONC: comments and trailing commas are allowed. */
function parseJsonc(text: string): unknown {
  const mask = computeCommentMask(text);
  let code = "";
  for (let i = 0; i < text.length; i++) if (mask[i]) code += text[i];
  return JSON.parse(code.replace(/^\uFEFF/, "").replace(/,(\s*[}\]])/g, "$1"));
}

/** Find every quoted string literal inside the (possibly nested-paren) argument list of `pattern(...)` matches. */
function extractStringLiteralArgs(
  text: string,
  openPattern: RegExp,
  mode: "first" | "all",
  mask: Uint8Array,
): Array<{ value: string; index: number }> {
  const out: Array<{ value: string; index: number }> = [];
  const litPattern = /(['"])((?:\\.|(?!\1).)*)\1/g;
  openPattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = openPattern.exec(text)) !== null) {
    if (!mask[m.index]) continue; // inside a comment/string
    const open = m.index + m[0].length - 1;
    const close = matchBracket(text, mask, open, "(", ")");
    if (close === -1) continue;
    const argsText = text.slice(open + 1, close);
    litPattern.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = litPattern.exec(argsText)) !== null) {
      out.push({ value: lm[2], index: open + 1 + lm.index });
      if (mode === "first") break;
    }
  }
  return out;
}

const FLAG_TYPE_NAME = /(?:Flags?|Features?|Toggles?)/i;

/**
 * A type declaration header; `record class X` / `record struct X` name `X`.
 * `class` and `struct` after `:` or `,` are generic constraints (`where T : class`), not types.
 */
const TYPE_HEADER = /(?<![:,]\s*)\b(?:class|struct|interface|record(?:\s+(?:class|struct))?)\s+(\w+)/;

/**
 * For each of `indexes` (ascending), the type names between the type's
 * opening brace at `braceIdx` and that index, outermost first (`["Checkout"]`
 * for a const inside `static class Checkout { ... }`), or undefined when it
 * sits in a non-type block such as a method body. One pass over the body;
 * comments, strings and preprocessor lines (`#region Nested class ...`) never
 * name a type.
 */
function nestedTypePaths(
  text: string,
  mask: Uint8Array,
  braceIdx: number,
  indexes: number[],
): Array<string[] | undefined> {
  const out: Array<string[] | undefined> = [];
  const stack: Array<string | undefined> = [];
  let header = "";
  let next = 0;
  for (let i = braceIdx + 1; next < indexes.length; i++) {
    while (next < indexes.length && indexes[next] <= i) {
      out.push(stack.every((name) => name !== undefined) ? [...(stack as string[])] : undefined);
      next++;
    }
    if (i >= text.length) break;
    if (!mask[i]) {
      header += " ";
      continue;
    }
    const c = text[i];
    if (c === "#" && /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i))) {
      const eol = text.indexOf("\n", i);
      i = (eol === -1 ? text.length : eol) - 1;
      continue;
    }
    if (c === "{") {
      stack.push(TYPE_HEADER.exec(header)?.[1]);
      header = "";
    } else if (c === "}") {
      stack.pop();
      header = "";
    } else if (c === ";") {
      header = "";
    } else {
      header += c;
    }
  }
  return out;
}

/**
 * Members of `class`/`struct`/`enum` types named like `*Flag(s)*`,
 * `*Feature(s)*` or `*Toggle(s)*` (common flag-registry conventions). A
 * const's flag name is its string value; an enum member's is its name.
 */
function findFlagTypeMembers(
  text: string,
): Array<{ flag: string; symbol: string; symbolKind: "const" | "enum-member"; index: number }> {
  const out: Array<{ flag: string; symbol: string; symbolKind: "const" | "enum-member"; index: number }> = [];
  const mask = computeCodeMask(text);
  // Keywords are lowercase in C#: a type named `Record` (`Save(Record featureFlags)`) declares nothing.
  // `record class X` names `X`, so a keyword is never taken as the name.
  const typePattern =
    /\b(class|struct|interface|record|enum)\s+(?!(?:class|struct)\b)(\w*(?:[Ff]lags?|[Ff]eatures?|[Tt]oggles?|FLAGS?|FEATURES?|TOGGLES?)\w*)\b/g;
  let tm: RegExpExecArray | null;
  while ((tm = typePattern.exec(text)) !== null) {
    if (!mask[tm.index]) continue;
    const isEnum = tm[1].toLowerCase() === "enum";
    const typeName = tm[2];
    const braceIdx = text.indexOf("{", tm.index + tm[0].length);
    if (braceIdx === -1) continue;
    // A body-less declaration (`record CheckoutFlags(string Name);`): the next brace belongs to something else.
    const semicolon = text.indexOf(";", tm.index + tm[0].length);
    if (semicolon !== -1 && semicolon < braceIdx && mask[semicolon]) continue;
    const closeIdx = matchBracket(text, mask, braceIdx, "{", "}");
    if (closeIdx === -1) continue;
    const body = text.slice(braceIdx + 1, closeIdx);
    const bodyStart = braceIdx + 1;

    if (isEnum) {
      let offset = 0;
      for (const rawLine of body.split("\n")) {
        const line = rawLine.trim();
        const leadingWs = rawLine.length - rawLine.trimStart().length;
        if (
          line &&
          !line.startsWith("//") &&
          !line.startsWith("[") &&
          !line.startsWith("*") &&
          !line.startsWith("/*")
        ) {
          const nm = /^([A-Za-z_]\w*)/.exec(line);
          if (nm) {
            const symbol = `${typeName}.${nm[1]}`;
            out.push({ flag: nm[1], symbol, symbolKind: "enum-member", index: bodyStart + offset + leadingWs });
          }
        }
        offset += rawLine.length + 1;
      }
    } else {
      const constPattern =
        /\b(?:public|internal|private|protected)?\s*(?:const|static\s+readonly)\s+string\s+(\w+)\s*=\s*(?:@?"([^"\\]*)"\s*;)?/g;
      const consts = [...body.matchAll(constPattern)].filter((cm) => mask[bodyStart + cm.index]);
      const paths = nestedTypePaths(
        text,
        mask,
        braceIdx,
        consts.map((cm) => bodyStart + cm.index),
      );
      consts.forEach((cm, k) => {
        const nested = paths[k];
        // Not a member of a type (a local in a method), or of a flag-named type that is scanned on its own.
        if (!nested || nested.some((name) => FLAG_TYPE_NAME.test(name))) return;
        out.push({
          flag: cm[2] || cm[1],
          symbol: [typeName, ...nested, cm[1]].join("."),
          symbolKind: "const",
          index: bodyStart + cm.index + cm[0].indexOf(cm[1]),
        });
      });
    }
  }
  return out;
}

/** Discover candidate flag names in a single file's text. */
export function discoverInText(text: string, file: string, project: string, ctx: ClassifyContext): FlagCandidate[] {
  const out: FlagCandidate[] = [];
  const source = new SourceText(file, text);
  const lineAt = (index: number) => source.position(index).line;

  if (file.endsWith(".json")) {
    const environment = configEnvironment(file);
    const states = featureManagementStates(text);
    for (const { key, index } of findFeatureManagementKeys(text)) {
      const { state, filters } = states.get(key) ?? { state: "unknown" as const };
      out.push({
        flag: key,
        project,
        source: "config",
        file,
        line: lineAt(index),
        environment,
        state,
        ...(filters ? { filters } : {}),
      });
    }
    return out;
  }

  // `computeCodeMask` assumes `//`-style string/comment syntax; an HTML
  // attribute's double-quoted value isn't a "string literal" to skip over,
  // so templates get an unmasked (all-code) pass instead.
  const mask = file.endsWith(".html") ? new Uint8Array(text.length).fill(1) : computeCodeMask(text);

  if (ctx.evalMethods.length) {
    const evalPattern = new RegExp(`\\b(?:${ctx.evalMethods.map(methodNamePattern).join("|")})\\s*\\(`, "g");
    for (const { value, index } of extractStringLiteralArgs(text, evalPattern, "first", mask)) {
      out.push({ flag: value, project, source: "eval", file, line: lineAt(index) });
    }
  }

  if (ctx.attributes.length) {
    const attrPattern = new RegExp(`\\[\\s*(?:${ctx.attributes.map(escapeRegExp).join("|")})\\s*\\(`, "g");
    for (const { value, index } of extractStringLiteralArgs(text, attrPattern, "all", mask)) {
      out.push({ flag: value, project, source: "attribute", file, line: lineAt(index) });
    }
  }

  if (file.endsWith(".cs")) {
    for (const { flag, symbol, symbolKind, index } of findFlagTypeMembers(text)) {
      out.push({ flag, project, source: "constant", file, line: lineAt(index), symbol, symbolKind });
    }
  }

  return out;
}
