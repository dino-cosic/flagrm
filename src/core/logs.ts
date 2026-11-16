/** Reading command logs: the lines that explain why a build or test run failed. */

import fs from "node:fs";

/** A log's non-blank lines, trimmed, without ANSI colors or the `$ <command>` header; undefined when unreadable. */
export function logLines(log: string | undefined): string[] | undefined {
  if (!log) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(log, "utf8");
  } catch {
    return undefined;
  }
  return (
    text
      .split(/\r?\n/)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors (ngc colors even when piped)
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
      .filter((line) => line && !line.startsWith("$ "))
  );
}

/** A log line that reports an error: not a compiler warning, nor a summary such as `0 Error(s)`. */
export function looksLikeError(line: string): boolean {
  return /\berror\b|\bfailed\b|✗|×/i.test(line) && !/:\s*warning\b/i.test(line) && !/^\d+ Error\(s\)$/i.test(line);
}

/**
 * Up to `max` distinct lines of a log that look like errors, so the reader sees
 * why a command failed without opening the log. Compiler warnings and summary
 * lines such as `0 Error(s)` are skipped: in a large build they bury the one
 * real error. When no line looks like an error, the last `max` lines instead.
 */
export function errorExcerpt(log: string | undefined, max = 10): string[] {
  const all = logLines(log);
  if (!all) return [];
  const lines = all.filter(looksLikeError);
  // No line says error (e.g. "A compatible .NET SDK was not found"): the end of the log usually does.
  if (!lines.length) return all.slice(-max);
  return [...new Set(lines)].slice(0, max);
}
