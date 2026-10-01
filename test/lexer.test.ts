import { describe, expect, it } from "vitest";
import { findFeatureManagementKeys } from "../src/core/discover.js";
import { computeLexicalMask, LEX_CODE, LEX_COMMENT, LEX_STRING } from "../src/core/scan.js";

/** The class of the character at the first occurrence of `marker` in `text`. */
const classAt = (text: string, marker: string, syntax: "slash" | "hash" = "slash") =>
  computeLexicalMask(text, syntax)[text.indexOf(marker)];

describe("computeLexicalMask", () => {
  it("classifies code, comments and strings", () => {
    const text = `const a = "x"; // note\n/* block */ call();`;
    expect(classAt(text, "const")).toBe(LEX_CODE);
    expect(classAt(text, "x")).toBe(LEX_STRING);
    expect(classAt(text, "note")).toBe(LEX_COMMENT);
    expect(classAt(text, "block")).toBe(LEX_COMMENT);
    expect(classAt(text, "call")).toBe(LEX_CODE);
  });

  it("confines a quote inside a regex literal to its line", () => {
    const text = `const re = /"/;\n// NewCheckout is gone\nuse();`;
    expect(classAt(text, "NewCheckout")).toBe(LEX_COMMENT);
    expect(classAt(text, "use")).toBe(LEX_CODE);
  });

  it("reads C# verbatim strings across lines, with doubled quotes", () => {
    const text = `var s = @"line one\n""quoted"" // not a comment\n";\nvar t = $@"{x}\n"; Call();`;
    expect(classAt(text, "not a comment")).toBe(LEX_STRING);
    expect(classAt(text, "{x}")).toBe(LEX_STRING);
    expect(classAt(text, "Call")).toBe(LEX_CODE);
  });

  it("reads C# raw strings and Python triple-quoted strings across lines", () => {
    expect(classAt(`var s = """\n// inside\n""";\nGo();`, "inside")).toBe(LEX_STRING);
    expect(classAt(`var s = """\n// inside\n""";\nGo();`, "Go")).toBe(LEX_CODE);
    expect(classAt(`s = '''\n# inside\n'''\ngo()`, "inside", "hash")).toBe(LEX_STRING);
    expect(classAt(`s = "a" # note`, "note", "hash")).toBe(LEX_COMMENT);
  });
});

describe("findFeatureManagementKeys", () => {
  it("returns the top-level FeatureManagement keys, skipping comments and nested filter config", () => {
    const text = [
      "{",
      '  // "Commented": true,',
      '  "FeatureManagement": {',
      '    "NewCheckout": true, /* "Hidden": false */',
      '    "Beta": { "EnabledFor": [{ "Name": "Percentage" }] }',
      "  },",
      '  "Other": { "NotAFlag": true }',
      "}",
    ].join("\n");
    expect(findFeatureManagementKeys(text).map((k) => k.key)).toEqual(["NewCheckout", "Beta"]);
    expect(text.slice(findFeatureManagementKeys(text)[0].index)).toMatch(/^"NewCheckout"/);
  });
});
