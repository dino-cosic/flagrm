import fs from "node:fs";
import type { ProjectContext } from "../../core/adapter.js";
import { discoverInText } from "../../core/discover.js";
import { LEX_CODE, LEX_STRING } from "../../core/scan.js";
import { SourceText } from "../../core/source-text.js";
import { toLf } from "../../core/text-utils.js";
import type { FlagCandidate } from "../../core/types.js";
import { closingParen, declaredName, evalCallPattern, isConfigFile, lexicalMask } from "./text.js";

/** A string literal that could hold a flag name. */
const FLAG_LIKE_LITERAL = /(['"`])([\w.:/-]{1,100})\1/g;

/**
 * Candidate flags for `flagrm list` in any language:
 * - `eval`: the first string literal passed to a configured eval method;
 * - `constant`: a `NAME = "flag"` declaration whose name is passed to one
 *   (`IsEnabled(ctx, flags.NewCheckout)`);
 * - `config`: `FeatureManagement` keys in `.json` files.
 */
export function discoverGeneric(ctx: ProjectContext): FlagCandidate[] {
  const out: FlagCandidate[] = [];
  const pattern = evalCallPattern(ctx.project.methods);
  const declared = new Map<string, Array<{ value: string; file: string; line: number }>>();
  const passed = new Set<string>();

  for (const file of ctx.files) {
    let text: string;
    try {
      text = toLf(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (file.endsWith(".json")) {
      out.push(...discoverInText(text, file, ctx.name, { evalMethods: [], attributes: [] }));
      continue;
    }
    if (isConfigFile(file)) continue;
    const mask = lexicalMask(file, text);
    const source = new SourceText(file, text);

    for (const m of text.matchAll(FLAG_LIKE_LITERAL)) {
      if (mask && mask[m.index] !== LEX_STRING) continue;
      const decl = declaredName(text, m.index, file);
      if (!decl) continue;
      const list = declared.get(decl.name) ?? [];
      list.push({ value: m[2], file, line: source.position(decl.start).line });
      declared.set(decl.name, list);
    }

    if (!pattern) continue;
    for (const m of text.matchAll(pattern)) {
      if (mask && mask[m.index] !== LEX_CODE) continue;
      const open = m.index + m[0].length - 1;
      const close = closingParen(text, mask, open);
      const lineEnd = text.indexOf("\n", open);
      const args = text.slice(open + 1, close !== -1 ? close : lineEnd !== -1 ? lineEnd : text.length);
      const literal = /(['"`])((?:\\.|(?!\1).)*)\1/.exec(args);
      if (literal) {
        out.push({
          flag: literal[2],
          project: ctx.name,
          source: "eval",
          file,
          line: source.position(open + 1 + literal.index).line,
        });
      }
      for (const id of args.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "").matchAll(/[A-Za-z_$][\w$]*/g)) passed.add(id[0]);
    }
  }

  for (const name of passed) {
    for (const d of declared.get(name) ?? []) {
      out.push({
        flag: d.value,
        project: ctx.name,
        source: "constant",
        file: d.file,
        line: d.line,
        symbol: name,
        symbolKind: "const",
      });
    }
  }
  return out;
}
