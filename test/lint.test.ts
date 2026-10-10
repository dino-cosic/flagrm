import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverNames, flagDir, writeBaseline } from "../src/core/baseline.js";
import { loadConfig } from "../src/core/config.js";
import { gitState } from "../src/core/git.js";
import { stopDecision } from "../src/core/hook.js";
import { resolveProjects } from "../src/core/registry.js";
import { baselineRuns, runsPath } from "../src/core/run-cache.js";
import type { CheckResult, VerifyReport } from "../src/core/types.js";
import { type VerifyOptions, verifyFlag } from "../src/core/verify/index.js";

// A generic project whose only command is `lint`: it prints the lines of a file
// outside the repo and fails when there are any, so a test sets what lint reports.

const FLAG = "FlagA";
let tmp: string;
let lintOut: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();
const commit = (message: string) => {
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message);
};
const write = (rel: string, text: string) => fs.writeFileSync(path.join(tmp, rel), text);
const lintSays = (...lines: string[]) => fs.writeFileSync(lintOut, lines.map((l) => `${l}\n`).join(""));
const workspace = () => resolveProjects(loadConfig({ quiet: true }, tmp));

const CONFIG = [
  "projects:",
  "  - name: app",
  "    adapter: generic",
  "    path: .",
  '    globs: ["**/*.txt"]',
  "    methods: [isEnabled]",
  "    build: false",
  "    test: false",
  "    lint: node lint.cjs",
  "",
].join("\n");
const NO_LINT = CONFIG.replace("    lint: node lint.cjs\n", "");

const LINT = [
  'const fs = require("node:fs");',
  'const out = fs.readFileSync(process.env.FLAGRM_TEST_LINT, "utf8");',
  // HANG: never finish, so the project's timeout kills it.
  'if (out.includes("HANG")) setInterval(() => {}, 1000);',
  "else {",
  "  process.stdout.write(out);",
  "  process.exit(out.trim() ? 1 : 0);",
  "}",
  "",
].join("\n");

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-lint-")));
  lintOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-lint-out-")), "out.txt");
  process.env.FLAGRM_TEST_LINT = lintOut;
  lintSays();
  write("flagrm.config.yaml", CONFIG);
  write("lint.cjs", LINT);
  write("app.txt", "hello\n");
  write(".gitignore", ".flagrm/\n");
  git("init", "-q");
  commit("init");
});

afterEach(() => {
  delete process.env.FLAGRM_TEST_LINT;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.dirname(lintOut), { recursive: true, force: true });
});

async function baseline(): Promise<void> {
  const projects = workspace();
  const checks = await baselineRuns(tmp, FLAG, projects, false);
  writeBaseline(tmp, FLAG, projects, gitState(tmp), checks, await discoverNames(projects, FLAG));
}

/** Edit the tree (as a removal would), then verify without reusing runs unless asked. */
async function verify(options: VerifyOptions = {}): Promise<VerifyReport> {
  write("app.txt", "removed\n");
  return (await verifyFlag(tmp, workspace(), FLAG, { reuse: false, ...options })).report;
}

const lint = (report: VerifyReport) => report.checks.find((c) => c.id === "lint") as CheckResult;
const messages = (check: CheckResult, severity: "fail" | "warn" | "info") =>
  check.findings.filter((f) => f.severity === severity).map((f) => f.message);

describe("lint check", () => {
  it("is skipped without a lint command", async () => {
    write("flagrm.config.yaml", NO_LINT);
    await baseline();
    expect(lint(await verify())).toMatchObject({ status: "skipped", summary: "no lint command configured" });
  });

  it("passes when lint exits 0", async () => {
    await baseline();
    const report = await verify();
    expect(lint(report)).toMatchObject({ status: "pass", summary: "app linted cleanly" });
    expect(report.runs.map((r) => r.check)).toEqual(["lint"]);
  });

  it("fails on a lint error the baseline didn't have", async () => {
    await baseline();
    lintSays("e2e/x.spec.ts:3:7 error TS6133: 'FeatureFlags' is declared but its value is never read");
    const report = await verify();
    expect(lint(report)).toMatchObject({ status: "fail", summary: "1 lint run failed" });
    expect(messages(lint(report), "info")).toContain(
      "e2e/x.spec.ts:3:7 error TS6133: 'FeatureFlags' is declared but its value is never read",
    );
    expect(report.status).toBe("fail");
  });

  it("only warns when lint already failed at the baseline, listing the new lines, and fails with --strict", async () => {
    lintSays("a.ts:1:1 error old problem");
    await baseline();
    // The old line, colored this time, is not new.
    lintSays("\u001b[31ma.ts:1:1 error old problem\u001b[0m", "b.ts:2:2 error new problem");
    const report = await verify();
    expect(lint(report)).toMatchObject({ status: "warn", summary: "1 lint run fails as at the baseline" });
    expect(messages(lint(report), "warn")).toEqual([
      expect.stringContaining("lint already failed at the baseline: 1 new line in the log"),
    ]);
    expect(messages(lint(report), "info")).toEqual(["new: b.ts:2:2 error new problem"]);
    expect(report.status).toBe("pass");
    expect((await verify({ strict: true })).status).toBe("fail");
  });

  it("says when no line is new, or when the baseline log is gone", async () => {
    lintSays("a.ts:1:1 error old problem");
    await baseline();
    expect(messages(lint(await verify()), "warn")).toEqual([expect.stringContaining("no new lines in the log")]);
    fs.rmSync(path.join(flagDir(tmp, FLAG), "app.lint.log"));
    const check = lint(await verify());
    expect(check.status).toBe("warn");
    expect(messages(check, "warn")).toEqual([expect.stringContaining("baseline log not found")]);
    expect(messages(check, "info")).toEqual([]);
  });

  it("fails without a lint run at the baseline, and says why", async () => {
    write("flagrm.config.yaml", NO_LINT);
    await baseline();
    write("flagrm.config.yaml", CONFIG);
    lintSays("a.ts:1:1 error old problem");
    const check = lint(await verify());
    expect(check.status).toBe("fail");
    expect(messages(check, "info")).toContain(
      "the baseline has no lint run to compare with (lint configured after it, or baseline --no-checks), so every lint error fails: show the user",
    );
    // Also "lint.cjs, named by the lint command, changed since the baseline": the command names a file.
    expect(messages(check, "warn")).toContain("lint command changed since the baseline: (none) → `node lint.cjs`");
  });

  it("fails on a setup problem even when lint failed at the baseline too", async () => {
    write("flagrm.config.yaml", CONFIG.replace("node lint.cjs", "flagrm-no-such-command-xyz"));
    await baseline();
    const check = lint(await verify());
    expect(check.status).toBe("fail");
    expect(messages(check, "info")).toContain(
      "setup problem: `flagrm-no-such-command-xyz` is not installed or not on PATH",
    );
  });

  it("lists a new error whose text matches an error the baseline already had", async () => {
    const unused = "1:10  error  'FeatureFlags' is defined but never used  no-unused-vars";
    lintSays("/r/a.ts", unused, "✖ 1 problem");
    await baseline();
    lintSays("/r/a.ts", unused, "/r/b.ts", unused, "✖ 2 problems");
    expect(messages(lint(await verify()), "info")).toEqual(["new: /r/b.ts", `new: ${unused}`, "new: ✖ 2 problems"]);
  });

  it("fails when lint was cut short, even when it failed at the baseline", async () => {
    write("flagrm.config.yaml", `${CONFIG}    timeout: 1\n`);
    lintSays("a.ts:1:1 error old problem");
    await baseline();
    lintSays("HANG");
    const check = lint(await verify());
    expect(check.status).toBe("fail");
  });

  it("fails on a lint error when the baseline's lint run was a setup problem", async () => {
    write("flagrm.config.yaml", CONFIG.replace("node lint.cjs", "flagrm-no-such-command-xyz"));
    await baseline();
    write("flagrm.config.yaml", CONFIG);
    lintSays("a.ts:1:1 error new problem");
    expect(lint(await verify()).status).toBe("fail");
  });

  it("runs no lint with --skip lint", async () => {
    await baseline();
    const report = await verify({ skip: ["lint"] });
    expect(lint(report)).toMatchObject({ status: "skipped", summary: "skipped (--skip)" });
    expect(report.runs).toEqual([]);
  });

  it("drops the saved runs once a fresh lint fails", async () => {
    await baseline();
    expect((await verify({ reuse: true })).status).toBe("pass");
    expect(fs.existsSync(runsPath(tmp, FLAG))).toBe(true);
    lintSays("a.ts:1:1 error new problem");
    expect((await verify()).status).toBe("fail");
    expect(fs.existsSync(runsPath(tmp, FLAG))).toBe(false);
  });

  it("accepts a lint command that writes a cache file in the tree: the Stop hook sees the verified tree", async () => {
    write("lint.cjs", `require("node:fs").writeFileSync(".lintcache", String(Date.now()));\n${LINT}`);
    commit("lint cache");
    await baseline();
    expect((await verify()).status).toBe("pass");
    expect(stopDecision(tmp, {})).toEqual({ block: false });
  });
});
