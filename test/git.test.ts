import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFilesSince } from "../src/core/git.js";

let tmp: string;

const git = (...args: string[]) => spawnSync("git", args, { cwd: tmp, encoding: "utf8" });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-git-")));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(tmp, "čačak.cs"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("changedFilesSince", () => {
  it("returns non-ASCII file names unquoted, tracked and untracked", () => {
    fs.writeFileSync(path.join(tmp, "čačak.cs"), "b\n");
    fs.writeFileSync(path.join(tmp, "šuma.cs"), "c\n");
    expect(changedFilesSince(tmp, "HEAD")).toEqual(["šuma.cs", "čačak.cs"].sort());
  });
});
