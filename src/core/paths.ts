/**
 * Where flagrm keeps a flag's state: `.flagrm/<flag>/` under the config root,
 * with `baseline.json` and `verify.json` in it.
 */

import { createHash } from "node:crypto";
import path from "node:path";

/**
 * `.flagrm/<flag>/` under the config root. A name that isn't safe as a directory
 * (`team/new`, `..`) is sanitized and suffixed with a hash of the original, so
 * it stays inside `.flagrm/` and can't collide with another flag's directory.
 */
export function flagDir(root: string, flag: string): string {
  const safe = flag.replace(/[^\w.-]/g, "_");
  if (flag && safe === flag && !flag.startsWith(".")) return path.join(root, ".flagrm", flag);
  const hash = createHash("sha256").update(flag).digest("hex").slice(0, 8);
  return path.join(root, ".flagrm", `${safe.replace(/^\.+/, "")}-${hash}`);
}

export function baselinePath(root: string, flag: string): string {
  return path.join(flagDir(root, flag), "baseline.json");
}

/** `.flagrm/<flag>/verify.json`: the last verify result. */
export function verifyPath(root: string, flag: string): string {
  return path.join(flagDir(root, flag), "verify.json");
}
