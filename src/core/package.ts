import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of the installed flagrm package (holds package.json and skills/); this file is src/core or dist/core. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The flagrm version from package.json, or `0.0.0` when it can't be read. */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
