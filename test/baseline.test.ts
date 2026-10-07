import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dotnetAdapter } from "../src/adapters/dotnet/index.js";
import { genericAdapter } from "../src/adapters/generic/index.js";
import {
  assertNoEditsSinceBaseline,
  baselinePath,
  baselineSummary,
  flagDir,
  readBaseline,
  runCheck,
  runChecks,
  UsageError,
  writeBaseline,
} from "../src/core/baseline.js";
import { gitState } from "../src/core/git.js";
import { JSON_SCHEMA_VERSION } from "../src/core/types.js";
import { projectContext } from "./support/projects.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-baseline-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();

describe("gitState", () => {
  it("returns a null sha outside a git repository", () => {
    expect(gitState(tmp)).toEqual({ sha: null, dirty: false });
  });

  it("returns HEAD and whether the tree is dirty", () => {
    git("init", "-q");
    fs.writeFileSync(path.join(tmp, "a.txt"), "a");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    expect(gitState(tmp)).toEqual({ sha: git("rev-parse", "HEAD"), dirty: false, dirtyFiles: [] });
    fs.writeFileSync(path.join(tmp, "a.txt"), "b");
    fs.writeFileSync(path.join(tmp, "new.txt"), "n");
    fs.mkdirSync(path.join(tmp, ".flagrm"));
    fs.writeFileSync(path.join(tmp, ".flagrm", "baseline.json"), "{}");
    expect(gitState(tmp)).toMatchObject({ dirty: true, dirtyFiles: ["a.txt", "new.txt"] });
  });
});

describe("writeBaseline", () => {
  it("writes .flagrm/<flag>/baseline.json with the git state and checks", () => {
    const checks = [{ project: "api", check: "build" as const, command: "x", exitCode: 0, durationMs: 1 }];
    const { file, baseline } = writeBaseline(tmp, "My/Flag", [], { sha: "abc", dirty: false }, checks);
    expect(file).toBe(path.join(tmp, ".flagrm", "My_Flag-d1725e32", "baseline.json"));
    expect(file).toBe(baselinePath(tmp, "My/Flag"));
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written).toEqual(baseline);
    expect(written).toMatchObject({
      schemaVersion: JSON_SCHEMA_VERSION,
      flag: "My/Flag",
      projects: [],
      git: { sha: "abc", dirty: false },
      checks,
      names: [],
    });
    expect(Date.parse(written.createdAt)).not.toBeNaN();
  });
});

describe("flagDir", () => {
  it("uses a plain flag name as is", () => {
    expect(flagDir(tmp, "NewCheckout")).toBe(path.join(tmp, ".flagrm", "NewCheckout"));
    expect(flagDir(tmp, "new-checkout.v2")).toBe(path.join(tmp, ".flagrm", "new-checkout.v2"));
  });

  it("keeps every name inside .flagrm/ and gives names that sanitize alike different directories", () => {
    const flagrm = path.join(tmp, ".flagrm");
    const dirs = ["..", ".", "", "../x", "Feature/New", "Feature_New", "Feature New"].map((f) => flagDir(tmp, f));
    for (const dir of dirs) expect(path.dirname(dir)).toBe(flagrm);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs.map((d) => path.basename(d)).filter((b) => b.startsWith("."))).toEqual([]);
  });
});

describe("runChecks", () => {
  it("runs each project's build and test commands inside its path and logs their output", async () => {
    fs.mkdirSync(path.join(tmp, "api"));
    const ctx = projectContext("dotnet", path.join(tmp, "api"), {
      name: "api",
      build: `node -e "console.log(process.cwd())"`,
      test: `node -e "console.error('boom'); process.exit(3)"`,
    });
    const logDir = path.join(tmp, ".flagrm", "F");
    const runs = await runChecks([{ adapter: dotnetAdapter, ctx }], logDir);
    expect(runs.map((r) => [r.project, r.check, r.exitCode])).toEqual([
      ["api", "build", 0],
      ["api", "test", 3],
    ]);
    expect(fs.readFileSync(runs[0].log!, "utf8")).toContain(path.join(tmp, "api"));
    expect(fs.readFileSync(runs[1].log!, "utf8")).toContain("boom");
  });

  it("keeps the adapter's default for the command a project doesn't configure", async () => {
    const ctx = projectContext("dotnet", tmp, { name: "api", build: `node -e ""` });
    const adapter = {
      ...dotnetAdapter,
      defaultCommands: () => ({ build: "exit 9", test: `node -e "process.exit(3)"` }),
    };
    const runs = await runChecks([{ adapter, ctx }], path.join(tmp, ".flagrm", "F"));
    expect(runs.map((r) => [r.check, r.command, r.exitCode])).toEqual([
      ["build", `node -e ""`, 0],
      ["test", `node -e "process.exit(3)"`, 3],
    ]);
  });

  it("runs no command, not even the default, for one configured as false", async () => {
    const ctx = projectContext("dotnet", tmp, { name: "api", build: `node -e ""`, test: false });
    const runs = await runChecks([{ adapter: dotnetAdapter, ctx }], path.join(tmp, ".flagrm", "F"));
    expect(runs.map((r) => r.check)).toEqual(["build"]);
  });

  it("falls back to the adapter's default commands when a project configures none", async () => {
    const ctx = projectContext("dotnet", tmp, { name: "api" });
    const adapter = { ...dotnetAdapter, defaultCommands: () => ({ build: `node -e ""` }) };
    const runs = await runChecks([{ adapter, ctx }], path.join(tmp, ".flagrm", "F"));
    expect(runs.map((r) => [r.check, r.command, r.exitCode])).toEqual([["build", `node -e ""`, 0]]);
  });
});

describe("runChecks with overlapping testResults patterns", () => {
  // Writes `file` (relative to the project) with one passing test named after the project.
  const writes = (file: string, name: string) => {
    const script = path.join(tmp, "write-trx.cjs");
    fs.writeFileSync(
      script,
      "const fs = require('fs'), path = require('path'); const [file, name] = process.argv.slice(2);" +
        "fs.mkdirSync(path.dirname(file), { recursive: true });" +
        'fs.writeFileSync(file, `<TestRun><UnitTestResult testName="${name}" outcome="Passed"/></TestRun>`);',
    );
    return `node "${script}" ${file} ${name}`;
  };
  const project = (name: string, dir: string, file: string, pattern: string) => {
    fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    return {
      adapter: genericAdapter,
      ctx: projectContext("generic", path.join(tmp, dir), { name, test: writes(file, name), testResults: pattern }),
    };
  };
  const names = (runs: Awaited<ReturnType<typeof runChecks>>) =>
    Object.fromEntries(runs.map((r) => [r.project, r.results?.names]));

  it("doesn't count a result file another project's run just wrote", async () => {
    const pattern = path.join(tmp, "**/TestResults/*.trx");
    const runs = await runChecks(
      [project("a", "a", "TestResults/a.trx", pattern), project("b", "b", "TestResults/b.trx", pattern)],
      path.join(tmp, ".flagrm", "F"),
      ["test"],
    );
    expect(names(runs)).toEqual({ a: ["a"], b: ["b"] });
  });

  it("reads a shared result file again when the next run rewrites it", async () => {
    const pattern = path.join(tmp, "TestResults/results.trx");
    const runs = await runChecks(
      [
        project("a", "a", "../TestResults/results.trx", pattern),
        project("b", "b", "../TestResults/results.trx", pattern),
      ],
      path.join(tmp, ".flagrm", "F"),
      ["test"],
    );
    expect(names(runs)).toEqual({ a: ["a"], b: ["b"] });
  });
});

describe("runCheck", () => {
  it("streams output past the old 64MB buffer without failing the command", async () => {
    const ctx = projectContext("generic", tmp, { name: "svc" });
    const log = path.join(tmp, "big.log");
    const run = await runCheck(ctx, "build", `node -e "process.stdout.write('x'.repeat(70 * 1024 * 1024))"`, log);
    expect(run.exitCode).toBe(0);
    expect(fs.statSync(log).size).toBeGreaterThan(70 * 1024 * 1024);
  });

  it("fails a command that outlives the project's timeout and says so in the log", async () => {
    const ctx = projectContext("generic", tmp, { name: "svc", timeout: 0.5 });
    const log = path.join(tmp, "slow.log");
    const run = await runCheck(ctx, "test", `node -e "setTimeout(() => {}, 10000)"`, log);
    expect(run.exitCode).toBe(1);
    // Killed well before the command's own 10s; taskkill is slow on a loaded Windows runner.
    expect(run.durationMs).toBeLessThan(9000);
    expect(fs.readFileSync(log, "utf8")).toContain("flagrm: error: timed out after 0.5s");
  });

  it("reads the JUnit results a test command writes into testResults", async () => {
    fs.mkdirSync(path.join(tmp, "web"));
    const junit = `<testsuite><testcase classname="A" name="one"/><testcase classname="A" name="two"><failure/></testcase></testsuite>`;
    const ctx = projectContext("angular", path.join(tmp, "web"), {
      name: "web",
      build: false,
      test: `node -e "require('fs').writeFileSync('junit.xml', '${junit.replace(/"/g, '\\"')}')"`,
      testResults: path.join(tmp, "web", "*.xml"),
    });
    const [run] = await runChecks([{ adapter: dotnetAdapter, ctx }], path.join(tmp, ".flagrm", "F"));
    expect(run.results).toMatchObject({ total: 2, passed: 1, failed: 1, failedNames: ["A › two"] });
  });
});

describe("assertNoEditsSinceBaseline", () => {
  const commit = () => git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qam", "c");
  const baseline = () => {
    const ctx = projectContext("generic", tmp, { name: "svc" });
    writeBaseline(tmp, "F", [{ adapter: dotnetAdapter, ctx }], gitState(tmp));
  };

  beforeEach(() => {
    git("init", "-q");
    fs.writeFileSync(path.join(tmp, "a.cs"), "a");
    fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), "projects: []\n");
    git("add", "-A");
    commit();
    baseline();
  });

  it("allows starting over before any edit, and after fixing only the flagrm config", () => {
    expect(() => assertNoEditsSinceBaseline(tmp, "F")).not.toThrow();
    fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), "projects: []\n# test: dotnet test --filter X\n");
    fs.writeFileSync(path.join(flagDir(tmp, "F"), "verify.json"), "{}");
    expect(() => assertNoEditsSinceBaseline(tmp, "F")).not.toThrow();
  });

  it("refuses once the code is edited, and says to stash uncommitted edits", () => {
    fs.writeFileSync(path.join(tmp, "a.cs"), "b");
    fs.writeFileSync(path.join(tmp, "new.cs"), "n");
    expect(() => assertNoEditsSinceBaseline(tmp, "F")).toThrow(UsageError);
    expect(() => assertNoEditsSinceBaseline(tmp, "F")).toThrow(
      /changed since the baseline of F \(a\.cs, new\.cs\).*git stash -u.*baseline F --force.*git stash pop/,
    );
  });

  it("doesn't count files matching testResults as edits", () => {
    fs.mkdirSync(path.join(tmp, "TestResults"));
    fs.writeFileSync(path.join(tmp, "TestResults", "run.trx"), "<TestRun />");
    expect(() => assertNoEditsSinceBaseline(tmp, "F")).toThrow(/TestResults\/run\.trx/);
    expect(() => assertNoEditsSinceBaseline(tmp, "F", [path.join(tmp, "TestResults", "*.trx")])).not.toThrow();
  });

  it("refuses edits committed after the baseline commit, which stashing can't set aside", () => {
    fs.writeFileSync(path.join(tmp, "a.cs"), "b");
    commit();
    expect(() => assertNoEditsSinceBaseline(tmp, "F")).toThrow(/a\.cs.*committed since the baseline commit/);
  });

  it("allows starting over outside git, where edits can't be told", () => {
    fs.rmSync(path.join(tmp, ".git"), { recursive: true });
    baseline();
    fs.writeFileSync(path.join(tmp, "a.cs"), "b");
    expect(() => assertNoEditsSinceBaseline(tmp, "F")).not.toThrow();
  });
});

describe("baselineSummary", () => {
  it("prints test results as counts and at most 20 short failed names, without the config", () => {
    const failedNames = Array.from({ length: 25 }, (_, i) => `Ns.T.Fails${i}(sut: x${i})`);
    const names = [...failedNames, ...Array.from({ length: 1000 }, (_, i) => `Ns.T.Passes${i}(sut: y)`)];
    const ctx = projectContext("generic", tmp, { name: "svc" });
    const run = {
      project: "svc",
      check: "test" as const,
      command: "t",
      exitCode: 1,
      durationMs: 1,
      results: { total: 1025, passed: 1000, failed: 25, skipped: 0, names, failedNames, files: ["a.trx", "b.trx"] },
    };
    const { baseline, file } = writeBaseline(tmp, "F", [{ adapter: dotnetAdapter, ctx }], { sha: null, dirty: false }, [
      run,
    ]);
    const summary = baselineSummary(baseline, file) as { checks: Array<{ results: Record<string, unknown> }> };
    expect(summary).not.toHaveProperty("config");
    expect(summary.checks[0].results).toEqual({
      total: 1025,
      passed: 1000,
      failed: 25,
      skipped: 0,
      files: 2,
      failedTests: failedNames.slice(0, 20).map((_, i) => `T.Fails${i}(…)`),
      moreFailedTests: 5,
    });
    expect(JSON.stringify(summary).length).toBeLessThan(3000);
    // baseline.json keeps every name.
    expect(JSON.parse(fs.readFileSync(file, "utf8")).checks[0].results.names).toHaveLength(1025);
  });
});

describe("readBaseline", () => {
  it("reads a version 6 baseline.json, whose shape version 7 only extended", () => {
    const ctx = projectContext("generic", tmp, { name: "svc" });
    const { file } = writeBaseline(tmp, "F", [{ adapter: dotnetAdapter, ctx }], { sha: null, dirty: false });
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), schemaVersion: 6 }));
    expect(readBaseline(tmp, "F").baseline.schemaVersion).toBe(6);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), schemaVersion: 5 }));
    expect(() => readBaseline(tmp, "F")).toThrow(UsageError);
  });
});
