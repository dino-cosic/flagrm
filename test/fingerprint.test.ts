import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFilesSince, headSha, isAncestor, treeAt, treeFingerprint } from "../src/core/git.js";

let tmp: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();
const commit = (message: string) => {
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message);
  return git("rev-parse", "HEAD");
};
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-fp-")));
  git("init", "-q");
  write("a.txt", "a\n");
  write("sub/b.txt", "b\n");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("treeFingerprint", () => {
  it("equals the commit's tree before any edit", () => {
    const sha = commit("init");
    expect(treeFingerprint(tmp)).toBe(treeAt(tmp, sha));
  });

  it("changes on an edit, a new untracked file and a deletion", () => {
    commit("init");
    const start = treeFingerprint(tmp);
    write("a.txt", "changed\n");
    const edited = treeFingerprint(tmp);
    expect(edited).not.toBe(start);
    write("new.txt", "n\n");
    const added = treeFingerprint(tmp);
    expect(added).not.toBe(edited);
    fs.rmSync(path.join(tmp, "sub", "b.txt"));
    expect(treeFingerprint(tmp)).not.toBe(added);
  });

  it("is unchanged by committing the same tree, including new files", () => {
    commit("init");
    write("a.txt", "changed\n");
    write("new.txt", "n\n");
    const before = treeFingerprint(tmp);
    commit("edit");
    expect(treeFingerprint(tmp)).toBe(before);
  });

  it("ignores .flagrm/", () => {
    commit("init");
    const start = treeFingerprint(tmp);
    write(".flagrm/Flag/verify.json", "{}");
    expect(treeFingerprint(tmp)).toBe(start);
  });

  it("ignores .flagrm/ when it is gitignored, as flagrm init sets it up", () => {
    write(".gitignore", ".flagrm/\n");
    const sha = commit("init");
    write(".flagrm/Flag/verify.json", "{}");
    expect(treeFingerprint(tmp)).toBe(treeAt(tmp, sha));
  });

  it("sees a same-size edit with an unchanged mtime, as git status does (racy git)", () => {
    // Pin the timestamps so the edit is racily clean: its stat matches the index entry, and only
    // the index file's own mtime tells git to compare contents. trustctime off takes ctime out of it.
    git("config", "core.trustctime", "false");
    const t = new Date(1_700_000_000_000);
    fs.utimesSync(path.join(tmp, "a.txt"), t, t);
    const sha = commit("init");
    fs.utimesSync(path.join(tmp, ".git", "index"), t, t);
    write("a.txt", "z\n");
    fs.utimesSync(path.join(tmp, "a.txt"), t, t);
    expect(treeFingerprint(tmp)).not.toBe(treeAt(tmp, sha));
    expect(git("status", "--porcelain")).toBe("M a.txt");
  });

  it("leaves the user's index untouched", () => {
    commit("init");
    write("a.txt", "changed\n");
    write("new.txt", "n\n");
    const status = git("status", "--porcelain");
    treeFingerprint(tmp);
    expect(git("status", "--porcelain")).toBe(status);
  });

  it("covers only the subdirectory when the config root is one", () => {
    const sha = commit("init");
    const sub = path.join(tmp, "sub");
    expect(treeFingerprint(sub)).toBe(treeAt(sub, sha));
    write("a.txt", "outside the root\n");
    expect(treeFingerprint(sub)).toBe(treeAt(sub, sha));
    write("sub/b.txt", "inside\n");
    expect(treeFingerprint(sub)).not.toBe(treeAt(sub, sha));
  });

  it("is undefined outside a git repository", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-plain-"));
    try {
      expect(treeFingerprint(plain)).toBeUndefined();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("leaves out the paths a filter ignores, matched literally, and so do the changed files", () => {
    commit("init");
    const head = headSha(tmp) as string;
    fs.mkdirSync(path.join(tmp, "gen"));
    fs.writeFileSync(path.join(tmp, "gen", "graph.json"), "{}");
    fs.writeFileSync(path.join(tmp, "[ab].txt"), "generated");
    fs.writeFileSync(path.join(tmp, "sub", "b.txt"), "tracked, edited, ignored");
    const ignore = (rel: string) => rel.startsWith("gen/") || rel === "[ab].txt" || rel === "sub/b.txt";
    expect(treeFingerprint(tmp, ignore)).toBe(treeAt(tmp, head));
    expect(changedFilesSince(tmp, head, ignore)).toEqual([]);
    fs.writeFileSync(path.join(tmp, "a.txt"), "edited");
    expect(treeFingerprint(tmp, ignore)).not.toBe(treeAt(tmp, head));
    expect(changedFilesSince(tmp, head, ignore)).toEqual(["a.txt"]);
  });
});

describe("headSha / isAncestor", () => {
  it("returns HEAD and tells ancestors apart", () => {
    expect(headSha(tmp)).toBeUndefined();
    const base = commit("init");
    expect(headSha(tmp)).toBe(base);
    write("a.txt", "one\n");
    const one = commit("one");
    expect(headSha(tmp)).toBe(one);
    expect(isAncestor(tmp, base)).toBe(true);
    expect(isAncestor(tmp, "0123456789012345678901234567890123456789")).toBe(false);
  });
});
