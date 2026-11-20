/**
 * Git plumbing for baselines and `verify`. Every path is relative
 * to the config root (`cwd`), and flagrm's own `.flagrm/` directory is ignored.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChangeFilter } from "./change-filter.js";
import type { GitState } from "./types.js";

/** Excludes flagrm's own output from every diff. */
const PATHSPEC = ["--", ".", ":(exclude).flagrm"];

/**
 * Lets read-only commands (`diff`, `status`) skip refreshing the index, which
 * takes `index.lock`: the Stop hook can run while the user or the agent runs
 * git, and their command would fail on the lock.
 */
const NO_OPTIONAL_LOCKS = { GIT_OPTIONAL_LOCKS: "0" };

function git(cwd: string, ...args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...NO_OPTIONAL_LOCKS },
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

/** Whether git reads `rev` as a revision: one starting with `-` (`--output=<file>`) would be an option. */
const isRevision = (rev: string) => rev !== "" && !rev.startsWith("-");

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

function hashObjects(cwd: string, files: string[]): string[] | undefined {
  const result = spawnSync("git", ["hash-object", "--stdin-paths"], {
    cwd,
    encoding: "utf8",
    input: `${files.join("\n")}\n`,
  });
  return result.status === 0 ? (result.stdout ?? "").split("\n") : undefined;
}

/**
 * Each file's git blob id as it is in the working tree (null when it doesn't
 * exist), so a later run can tell whether it changed since. A file git can't
 * hash (a submodule directory) gets an id of its own each time, so it always
 * counts as changed. Paths are relative to `cwd`.
 */
export function blobIds(cwd: string, files: string[]): Record<string, string | null> {
  const ids: Record<string, string | null> = {};
  const existing = files.filter((rel) => fs.existsSync(path.join(cwd, rel)));
  for (const rel of files) ids[rel] = null;
  if (existing.length === 0) return ids;
  // One git call for all files; when it fails, one per file, so a single unhashable path doesn't spoil the rest.
  const out = hashObjects(cwd, existing);
  existing.forEach((rel, i) => {
    ids[rel] = (out ? out[i] : hashObjects(cwd, [rel])?.[0]) || `unhashable:${randomUUID()}`;
  });
  return ids;
}

/**
 * Files added, modified or deleted in the working tree since `sha` (staged or
 * not), plus untracked files unless `untracked` is false, without the ones
 * `ignore` names. Undefined when git can't tell.
 */
export function changedFilesSince(
  cwd: string,
  sha: string,
  ignore?: ChangeFilter,
  options: { untracked?: boolean } = {},
): string[] | undefined {
  if (!isRevision(sha)) return undefined;
  const diff = git(cwd, "diff", "-z", "--name-only", "--no-renames", "--relative", sha, ...PATHSPEC);
  if (!diff.ok) return undefined;
  const extra = options.untracked === false ? [] : untracked(cwd);
  const all = [...new Set([...paths(diff.stdout), ...extra])].sort();
  return ignore ? all.filter((rel) => !ignore(rel)) : all;
}

/** A file's content at `sha`, or undefined when it did not exist there. */
export function fileAt(cwd: string, sha: string, relativePath: string): string | undefined {
  if (!isRevision(sha)) return undefined;
  const result = git(cwd, "show", `${sha}:./${relativePath.split(path.sep).join("/")}`);
  return result.ok ? result.stdout : undefined;
}

/** A scratch index and object store: objects git writes go to `objects`, and the repository's own stay readable. */
interface Scratch {
  index: string;
  objects: string;
  realObjects: string;
}

/**
 * `dir` as one entry of `GIT_ALTERNATE_OBJECT_DIRECTORIES`, which git splits
 * on `:` (`;` on Windows): a path containing the separator, or starting with a
 * quote, goes in C-style quotes, which git reads as one path.
 */
export function alternatePath(dir: string): string {
  if (!dir.includes(path.delimiter) && !dir.startsWith('"')) return dir;
  return `"${dir.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function gitWithIndex(cwd: string, scratch: Scratch, args: string[], input?: string): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    input,
    env: {
      ...process.env,
      ...NO_OPTIONAL_LOCKS,
      GIT_INDEX_FILE: scratch.index,
      // The blobs and trees `add` and `write-tree` create land in the temporary directory and are deleted with it,
      // instead of piling up as unreachable objects in the repository until `git gc`.
      GIT_OBJECT_DIRECTORY: scratch.objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatePath(scratch.realObjects),
      // Literal: a file named `[ab].txt` must not match `a.txt` when its path is passed back to git.
      GIT_LITERAL_PATHSPECS: input === undefined ? undefined : "1",
    },
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
 * tracked and untracked files, not ignored ones, without `.flagrm/` and the
 * paths `ignore` names. Built in a temporary copy of the index and a temporary
 * object store, so the user's index is untouched and no objects are left
 * behind in the repository. Committing the tree doesn't change it; any edit does.
 * Before any edit it equals {@link treeAt} of HEAD, as long as the ignored
 * paths are unchanged since.
 */
export function treeFingerprint(cwd: string, ignore?: ChangeFilter): string | undefined {
  const prefix = repoPrefix(cwd);
  if (prefix === undefined) return undefined;
  const gitPaths = git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "index", "--git-path", "objects");
  const [realIndex, realObjects] = gitPaths.stdout.split("\n").map((line) => line.trim());
  if (!gitPaths.ok || !realIndex || !realObjects) return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-index-"));
  const scratch: Scratch = { index: path.join(dir, "index"), objects: path.join(dir, "objects"), realObjects };
  try {
    fs.mkdirSync(scratch.objects);
    // Keep the index's mtime: git compares it with entry mtimes to catch same-second ("racy") edits.
    if (fs.existsSync(realIndex)) fs.cpSync(realIndex, scratch.index, { preserveTimestamps: true });
    // Not PATHSPEC: `git add` exits 1 when an exclude pathspec names an ignored path (`.flagrm/` usually is).
    if (!gitWithIndex(cwd, scratch, ["add", "-A", "--", "."]).ok) return undefined;
    if (!gitWithIndex(cwd, scratch, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".flagrm"]).ok)
      return undefined;
    if (ignore && !dropIgnored(cwd, scratch, ignore)) return undefined;
    const tree = gitWithIndex(cwd, scratch, ["write-tree", ...(prefix ? [`--prefix=${prefix}`] : [])]);
    return tree.ok ? tree.stdout.trim() : undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Put back each path `ignore` names as it is at HEAD (or drop it, if HEAD
 * doesn't have it), so the fingerprint doesn't see changes to it.
 */
function dropIgnored(cwd: string, scratch: Scratch, ignore: ChangeFilter): boolean {
  const head = headSha(cwd);
  // The paths that differ from HEAD, deleted ones included: `ls-files` no longer lists a deleted file.
  // Before the first commit there is no HEAD to compare with, so every path in the index.
  const listing = head
    ? gitWithIndex(cwd, scratch, ["diff-index", "--cached", "--name-only", "--no-renames", "--relative", "-z", "HEAD"])
    : gitWithIndex(cwd, scratch, ["ls-files", "-z"]);
  if (!listing.ok) return false;
  const listed = paths(listing.stdout).filter(ignore);
  if (listed.length === 0) return true;
  const input = `${listed.join("\0")}\0`;
  const fromFile = ["--pathspec-from-file=-", "--pathspec-file-nul"];
  // `reset` also drops a path HEAD doesn't have; before the first commit there is no HEAD to reset to.
  const args = head ? ["reset", "-q", "HEAD", ...fromFile] : ["rm", "-q", "--cached", ...fromFile];
  return gitWithIndex(cwd, scratch, args, input).ok;
}

/** The tree id of `cwd` at commit `sha`. */
export function treeAt(cwd: string, sha: string): string | undefined {
  if (!isRevision(sha)) return undefined;
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
  return isRevision(sha) && git(cwd, "merge-base", "--is-ancestor", sha, "HEAD").ok;
}
