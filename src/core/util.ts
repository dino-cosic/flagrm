/** Small helpers shared across flagrm's modules. */

import fs from "node:fs";
import path from "node:path";

/** `1 flag`, `2 flags`; `many` for irregular plurals. */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** `file` relative to `from`, with `/` separators on every platform. */
export function relativePath(from: string, file: string): string {
  return path.relative(from, file).split(path.sep).join("/");
}

/** A plain object: not null, not an array. */
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The items of a comma-separated list (`--skip build,tests`), trimmed, without empty ones. */
export const splitList = (value: string): string[] =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Write `value` as JSON to `file` (creating its directory) through a temporary
 * file and a rename, so a reader such as the Stop hook never sees half a file.
 */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** A JSON file's parsed content, or undefined when it is missing or not valid JSON. */
export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Whether `exe` can be run from `cwd`: a path that exists, or a program on PATH (with PATHEXT on Windows). */
export function onPath(exe: string, cwd: string): boolean {
  if (exe.includes("/") || exe.includes("\\")) return fs.existsSync(path.resolve(cwd, exe));
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => exts.some((ext) => fs.existsSync(path.join(dir, exe + ext))));
}
