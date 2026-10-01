import path from "node:path";
import fg from "fast-glob";

export const BACKEND_GLOBS = [
  "**/*.cs",
  "**/*.cshtml",
  "**/*.razor",
  "**/appsettings*.json",
  // Generated EF Core migration metadata: often most of a solution's C# by size, and never flag logic.
  "!**/Migrations/*.Designer.cs",
  "!**/Migrations/*ModelSnapshot.cs",
];
export const FRONTEND_GLOBS = ["**/*.ts", "**/*.html"];

export const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/bin/**",
  "**/obj/**",
  "**/dist/**",
  "**/coverage/**",
  "**/.angular/**",
  "**/.git/**",
];

export interface GlobOverrides {
  /** Additional glob patterns to include, on top of the built-in language globs. */
  include?: string[];
  /** Additional glob patterns to exclude, on top of the built-in ignore list. */
  exclude?: string[];
}

/** Absolute paths with the platform's separators (fast-glob returns `/` on Windows too), so they match `path.join`. */
export function listProjectFiles(root: string, globs: string[], overrides?: GlobOverrides): string[] {
  const patterns = [...globs, ...(overrides?.include ?? [])];
  const ignore = [...IGNORE_GLOBS, ...(overrides?.exclude ?? [])];
  return fg.sync(patterns, { cwd: root, ignore, absolute: true, dot: false }).map((file) => path.normalize(file));
}

export interface ClassifyContext {
  evalMethods: string[];
  attributes: string[];
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the regex fragment for a configured method-name entry. An entry may
 * pin a specific generic argument (`"GetValue<bool>"`, matching only that
 * exact instantiation) or be a bare name (`"IsEnabled"`, matching an optional
 * generic argument list of any shape — `Foo(...)` or `Foo<T>(...)`).
 */
export function methodNamePattern(entry: string): string {
  const m = /^([\w.]+)\s*<\s*([^>]+)\s*>$/.exec(entry.trim());
  if (m) {
    const [, name, generic] = m;
    return `${escapeRegExp(name)}\\s*<\\s*${escapeRegExp(generic.trim())}\\s*>`;
  }
  return `${escapeRegExp(entry)}\\s*(?:<[^>]*>\\s*)?`;
}

/**
 * Whether a file (relative to its project root) is test code: `*.spec.ts`/
 * `*.test.ts`, `*Tests.cs`, `*_test.go`, `test_*.py`/`*_test.py`,
 * `*Test.java`/`*Tests.kt`, `*_spec.rb`, or anything under a `test`/`tests`
 * directory or a `*.Tests`/`*-tests` project directory.
 */
export function isTestPath(relativePath: string): boolean {
  return (
    /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(relativePath) ||
    /Tests?\.(?:cs|java|kt)$/.test(relativePath) ||
    /_test\.(?:go|py)$/.test(relativePath) ||
    /(?:^|[\\/])test_[^\\/]*\.py$/.test(relativePath) ||
    /_spec\.rb$/.test(relativePath) ||
    /(?:^|[\\/])(?:[^\\/]*[.\-_])?tests?[\\/]/i.test(relativePath)
  );
}

/** How a language writes comments: `//` and `/* *\/`, or `#`. */
export type CommentSyntax = "slash" | "hash";

const SLASH_COMMENT_EXTENSIONS = new Set([
  ".cs",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".swift",
  ".rs",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".dart",
  ".php",
]);

const HASH_COMMENT_EXTENSIONS = new Set([
  ".py",
  ".rb",
  ".sh",
  ".bash",
  ".yaml",
  ".yml",
  ".toml",
  ".properties",
  ".ini",
  ".cfg",
  ".conf",
  ".tf",
  ".ex",
  ".exs",
]);

/** Key/value config formats: their `key:` / `key=` lines configure things rather than run code. */
const KEY_VALUE_EXTENSIONS = new Set([".yaml", ".yml", ".toml", ".properties", ".ini", ".cfg", ".conf"]);

/** A file's lowercased base name and extension, and whether it is a `.env` file. */
function fileName(file: string): { ext: string; isEnv: boolean } {
  const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return { ext: dot === -1 ? "" : base.slice(dot), isEnv: base === ".env" || base.startsWith(".env.") };
}

/** The comment syntax of a file, by extension (or `.env` name); undefined when flagrm doesn't know it (HTML, JSON, ...). */
export function commentSyntax(file: string): CommentSyntax | undefined {
  const { ext, isEnv } = fileName(file);
  if (isEnv) return "hash";
  if (SLASH_COMMENT_EXTENSIONS.has(ext)) return "slash";
  if (HASH_COMMENT_EXTENSIONS.has(ext)) return "hash";
  return undefined;
}

/** YAML, TOML, properties, ini/cfg/conf and `.env` files: key/value config that the code scan reads as plain text. */
export function isKeyValueConfig(file: string): boolean {
  const { ext, isEnv } = fileName(file);
  return isEnv || KEY_VALUE_EXTENSIONS.has(ext);
}

/** Character classes of {@link computeLexicalMask}. */
export const LEX_CODE = 0;
export const LEX_COMMENT = 1;
export const LEX_STRING = 2;

/**
 * Classify every character as code, comment or string (quotes included), for
 * `//`-style or `#`-style languages. `'`, `"` and `` ` `` open strings that end
 * at the line's end (only backtick strings span lines), so a quote the lexer
 * misreads (a regex literal such as `/"/`) mislabels one line, not the rest of
 * the file. Multi-line strings: in `#` languages `"""` and `'''` (Python); in
 * `//` languages C# raw `"""` strings and verbatim `@"..."` strings, where
 * `""` is an escaped quote.
 */
export function computeLexicalMask(text: string, syntax: CommentSyntax): Uint8Array {
  const mask = new Uint8Array(text.length);
  const fill = (from: number, to: number, cls: number) => mask.fill(cls, from, Math.min(to, text.length));
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if ((syntax === "slash" && c === "/" && next === "/") || (syntax === "hash" && c === "#")) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      fill(i, stop, LEX_COMMENT);
      i = stop;
    } else if (syntax === "slash" && c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      fill(i, stop, LEX_COMMENT);
      i = stop;
    } else if (text.startsWith('"""', i) || (syntax === "hash" && text.startsWith("'''", i))) {
      const end = text.indexOf(text.slice(i, i + 3), i + 3);
      const stop = end === -1 ? text.length : end + 3;
      fill(i, stop, LEX_STRING);
      i = stop;
    } else if (
      syntax === "slash" &&
      (text.startsWith('@"', i) || text.startsWith('$@"', i) || text.startsWith('@$"', i))
    ) {
      const start = i;
      i = text.indexOf('"', i) + 1;
      while (i < text.length && !(text[i] === '"' && text[i + 1] !== '"')) i += text[i] === '"' ? 2 : 1;
      fill(start, i + 1, LEX_STRING);
      i++;
    } else if (c === '"' || c === "'" || c === "`") {
      mask[i++] = LEX_STRING;
      while (i < text.length && text[i] !== c && (c === "`" || text[i] !== "\n")) {
        if (text[i] === "\\") mask[i++] = LEX_STRING;
        if (i < text.length) mask[i++] = LEX_STRING;
      }
      if (i < text.length && text[i] === c) mask[i++] = LEX_STRING;
    } else {
      i++;
    }
  }
  return mask;
}

/** 1 where {@link computeLexicalMask} finds code, 0 in comments and strings. */
export function computeCodeMask(text: string, syntax: CommentSyntax = "slash"): Uint8Array {
  return computeLexicalMask(text, syntax).map((c) => (c === LEX_CODE ? 1 : 0));
}

/**
 * Comment mask (0 = inside a comment, 1 = anything else, strings included) for
 * a file whose comment syntax flagrm knows, otherwise null.
 */
export function commentMaskFor(file: string, text: string): Uint8Array | null {
  const syntax = commentSyntax(file);
  return syntax ? computeCommentMask(text, syntax) : null;
}

/** 0 where {@link computeLexicalMask} finds a comment, 1 elsewhere. */
export function computeCommentMask(text: string, syntax: CommentSyntax = "slash"): Uint8Array {
  return computeLexicalMask(text, syntax).map((c) => (c === LEX_COMMENT ? 0 : 1));
}
