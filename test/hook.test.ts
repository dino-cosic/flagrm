import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flagDir, verifyPath, writeBaseline } from "../src/core/baseline.js";
import { gitState, treeFingerprint } from "../src/core/git.js";
import { hookRoot, parseHookInput, stopDecision } from "../src/core/hook.js";

let tmp: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();
const commit = (message: string) => {
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message);
};
const edit = (text: string) => fs.writeFileSync(path.join(tmp, "a.txt"), text);
const baseline = (flag = "NewCheckout") => writeBaseline(tmp, flag, [], gitState(tmp));
const verified = (status: "pass" | "fail", flag = "NewCheckout", skipped: string[] = []) => {
  fs.mkdirSync(flagDir(tmp, flag), { recursive: true });
  fs.writeFileSync(verifyPath(tmp, flag), JSON.stringify({ flag, status, fingerprint: treeFingerprint(tmp), skipped }));
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-hook-")));
  git("init", "-q");
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".flagrm/\n");
  edit("a\n");
  commit("init");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("stopDecision", () => {
  it("allows when there is no .flagrm/ directory", () => {
    expect(stopDecision(tmp, {})).toEqual({ block: false });
  });

  it("allows when the removal hasn't started", () => {
    baseline();
    expect(stopDecision(tmp, {})).toEqual({ block: false });
  });

  it("allows while the removal is paused before any edit: only the flagrm config or untracked files changed", () => {
    fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), "projects: []\n");
    commit("config");
    baseline();
    fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), "projects: []\n# test: dotnet test flagrm.slnf\n");
    fs.mkdirSync(path.join(tmp, "TestResults"));
    fs.writeFileSync(path.join(tmp, "TestResults", "run.trx"), "<TestRun/>");
    fs.writeFileSync(path.join(tmp, "flagrm.slnf"), "{}");
    expect(stopDecision(tmp, {})).toEqual({ block: false });
  });

  it("blocks a deleted tracked file", () => {
    baseline();
    fs.rmSync(path.join(tmp, "a.txt"));
    expect(stopDecision(tmp, {}).block).toBe(true);
  });

  it("blocks before any edit when the last verify skipped checks", () => {
    baseline();
    verified("pass", "NewCheckout", ["tests"]);
    expect(stopDecision(tmp, {})).toEqual({
      block: true,
      reason: "flagrm: NewCheckout verified with --skip tests — run flagrm verify NewCheckout --json without --skip",
    });
  });

  it("blocks an edited tree without a verify result", () => {
    baseline();
    edit("b\n");
    expect(stopDecision(tmp, {})).toEqual({
      block: true,
      reason: "flagrm: NewCheckout removal not verified — run flagrm verify NewCheckout --json",
    });
  });

  it("allows once verify passed on the current tree", () => {
    baseline();
    edit("b\n");
    verified("pass");
    expect(stopDecision(tmp, {}).block).toBe(false);
  });

  it("blocks a passing verify that skipped checks", () => {
    baseline();
    edit("b\n");
    verified("pass", "NewCheckout", ["build", "tests"]);
    expect(stopDecision(tmp, {})).toEqual({
      block: true,
      reason:
        "flagrm: NewCheckout verified with --skip build,tests — run flagrm verify NewCheckout --json without --skip",
    });
  });

  it("blocks a passing verify from a flagrm version that didn't record skips", () => {
    baseline();
    edit("b\n");
    fs.mkdirSync(flagDir(tmp, "NewCheckout"), { recursive: true });
    const report = { flag: "NewCheckout", status: "pass", fingerprint: treeFingerprint(tmp) };
    fs.writeFileSync(verifyPath(tmp, "NewCheckout"), JSON.stringify(report));
    expect(stopDecision(tmp, {}).block).toBe(true);
  });

  it("blocks when verify failed", () => {
    baseline();
    edit("b\n");
    verified("fail");
    expect(stopDecision(tmp, {}).block).toBe(true);
  });

  it("blocks an edit made after a passing verify", () => {
    baseline();
    edit("b\n");
    verified("pass");
    edit("c\n");
    expect(stopDecision(tmp, {}).block).toBe(true);
  });

  it("allows a verified removal that was committed, even after later edits", () => {
    baseline();
    edit("b\n");
    verified("pass");
    commit("remove flag");
    edit("unrelated work\n");
    expect(stopDecision(tmp, {}).block).toBe(false);
  });

  it("stops guarding a removal once HEAD moves: an unverified removal that was committed", () => {
    baseline();
    edit("b\n");
    commit("remove flag, unverified");
    edit("more work\n");
    expect(stopDecision(tmp, {})).toEqual({ block: false });
  });

  it("ignores a removal left on another branch", () => {
    baseline();
    edit("b\n");
    git("stash", "-q");
    git("checkout", "-qb", "other");
    fs.writeFileSync(path.join(tmp, "other.txt"), "x\n");
    commit("other work");
    edit("unrelated\n");
    expect(stopDecision(tmp, {})).toEqual({ block: false });
  });

  it("still blocks the removal in progress when another one is stale", () => {
    baseline("Old");
    fs.writeFileSync(path.join(tmp, "later.txt"), "x\n");
    commit("later commit");
    baseline();
    edit("b\n");
    expect(stopDecision(tmp, {})).toEqual({
      block: true,
      reason: "flagrm: NewCheckout removal not verified — run flagrm verify NewCheckout --json",
    });
  });

  it("allows when stop_hook_active is set, to avoid loops", () => {
    baseline();
    edit("b\n");
    expect(stopDecision(tmp, { stop_hook_active: true })).toEqual({ block: false });
  });

  it("names the flag from the baseline, not the sanitized directory", () => {
    baseline("team/new-checkout");
    edit("b\n");
    expect(stopDecision(tmp, {}).reason).toContain("run flagrm verify team/new-checkout --json");
  });

  it("allows on a corrupt baseline.json", () => {
    baseline();
    edit("b\n");
    fs.writeFileSync(path.join(flagDir(tmp, "NewCheckout"), "baseline.json"), "{not json");
    expect(stopDecision(tmp, {})).toEqual({ block: false });
  });

  it("allows outside a git repository", () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-hook-plain-")));
    try {
      writeBaseline(plain, "NewCheckout", [], { sha: null, dirty: false });
      expect(stopDecision(plain, {})).toEqual({ block: false });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("parseHookInput", () => {
  it("reads the fields flagrm uses from a JSON object", () => {
    expect(parseHookInput('{"stop_hook_active":true,"cwd":"/r","session_id":"x"}')).toEqual({
      stop_hook_active: true,
      cwd: "/r",
    });
  });

  it("returns defaults for empty, malformed or non-object input, and fields of the wrong type", () => {
    for (const text of ["", "not json", "null", "5", '"s"', "[1]", '{"stop_hook_active":"yes","cwd":3}']) {
      expect(parseHookInput(text)).toEqual({});
    }
  });
});

describe("hookRoot", () => {
  it("finds the config in a parent directory, so a hook run from a subdirectory still checks the removal", () => {
    fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), "projects: []\n");
    fs.mkdirSync(path.join(tmp, "src", "deep"), { recursive: true });
    expect(hookRoot(path.join(tmp, "src", "deep"))).toBe(tmp);
  });

  it("falls back to the directory itself without a config", () => {
    expect(hookRoot(tmp)).toBe(tmp);
  });
});
