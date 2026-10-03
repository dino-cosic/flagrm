/** Small helpers shared across flagrm's modules. */

import fs from "node:fs";
import path from "node:path";

/** `1 flag`, `2 flags`; `many` for irregular plurals. */
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** `file` relative to `from`, with `/` separators on every platform. */
export function relativePath(from: string, file: string): string {
  return path.relative(from, file).split(path.sep).join("/");
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
