/**
 * Git plumbing for baselines and `verify`. Every path is relative
 * to the config root (`cwd`), and flagrm's own `.flagrm/` directory is ignored.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitState } from "./types.js";

/** Excludes flagrm's own output from every diff. */
const PATHSPEC = ["--", ".", ":(exclude).flagrm"];

function git(cwd: string, ...args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

/** NUL-separated paths (`-z`), which git never quotes or escapes, whatever the file name. */
const paths = (text: string) => text.split("\0").filter(Boolean);

/** Untracked (and not ignored) files under `cwd`. */
function untracked(cwd: string): string[] {
  return paths(git(cwd, "ls-files", "-z", "--others", "--exclude-standard", ...PATHSPEC).stdout);
}

/** HEAD commit and the files with uncommitted changes (`sha: null` outside a git repository). */
export function gitState(cwd: string): GitState {
  const head = git(cwd, "rev-parse", "HEAD");
  if (!head.ok) return { sha: null, dirty: false };
  const dirtyFiles = changedFilesSince(cwd, "HEAD") ?? [];
  return { sha: head.stdout.trim(), dirty: dirtyFiles.length > 0, dirtyFiles };
}

/** Files added, modified or deleted in the working tree since `sha` (tracked diff plus untracked files). */
export function changedFilesSince(cwd: string, sha: string): string[] | undefined {
  const diff = git(cwd, "diff", "-z", "--name-only", "--no-renames", "--relative", sha, ...PATHSPEC);
  if (!diff.ok) return undefined;
  return [...new Set([...paths(diff.stdout), ...untracked(cwd)])].sort();
}

/**
 * Tracked files modified or deleted in the working tree since `sha` (staged
 * or not); untracked files don't count. Undefined when git can't tell.
 */
export function trackedChangesSince(cwd: string, sha: string): string[] | undefined {
  const diff = git(cwd, "diff", "-z", "--name-only", "--no-renames", "--relative", sha, ...PATHSPEC);
  return diff.ok ? paths(diff.stdout).sort() : undefined;
}

/** A file's content at `sha`, or undefined when it did not exist there. */
export function fileAt(cwd: string, sha: string, relativePath: string): string | undefined {
  const result = git(cwd, "show", `${sha}:./${relativePath.split(path.sep).join("/")}`);
  return result.ok ? result.stdout : undefined;
}

function gitWithIndex(cwd: string, index: string, ...args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_INDEX_FILE: index },
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

/** `cwd` relative to the repository root with a trailing slash (`""` at the root); undefined outside git. */
function repoPrefix(cwd: string): string | undefined {
  const result = git(cwd, "rev-parse", "--show-prefix");
  return result.ok ? result.stdout.trim() : undefined;
}

/**
 * The git tree id of the working tree under `cwd` as it would be committed:
 * tracked and untracked files, not ignored ones, without `.flagrm/`. Built in a
 * temporary copy of the index, so the user's index is untouched. Committing
 * the tree doesn't change it; any edit does. Before any edit it equals
 * {@link treeAt} of HEAD.
 */
export function treeFingerprint(cwd: string): string | undefined {
  const prefix = repoPrefix(cwd);
  if (prefix === undefined) return undefined;
  const realIndex = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index").stdout.trim();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-index-"));
  const index = path.join(dir, "index");
  try {
    // Keep the index's mtime: git compares it with entry mtimes to catch same-second ("racy") edits.
    if (realIndex && fs.existsSync(realIndex)) fs.cpSync(realIndex, index, { preserveTimestamps: true });
    // Not PATHSPEC: `git add` exits 1 when an exclude pathspec names an ignored path (`.flagrm/` usually is).
    if (!gitWithIndex(cwd, index, "add", "-A", "--", ".").ok) return undefined;
    if (!gitWithIndex(cwd, index, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".flagrm").ok)
      return undefined;
    const tree = gitWithIndex(cwd, index, "write-tree", ...(prefix ? [`--prefix=${prefix}`] : []));
    return tree.ok ? tree.stdout.trim() : undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The tree id of `cwd` at commit `sha`. */
export function treeAt(cwd: string, sha: string): string | undefined {
  const prefix = repoPrefix(cwd);
  if (prefix === undefined) return undefined;
  const result = git(cwd, "rev-parse", "--verify", "--quiet", `${sha}:${prefix}`);
  return result.ok ? result.stdout.trim() : undefined;
}

/** The HEAD commit, or undefined outside a git repository or before the first commit. */
export function headSha(cwd: string): string | undefined {
  const result = git(cwd, "rev-parse", "--verify", "--quiet", "HEAD");
  return result.ok ? result.stdout.trim() : undefined;
}

/** Whether `sha` is HEAD or one of its ancestors. */
export function isAncestor(cwd: string, sha: string): boolean {
  return git(cwd, "merge-base", "--is-ancestor", sha, "HEAD").ok;
}
