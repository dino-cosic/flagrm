import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dotnetAdapter } from "../src/adapters/dotnet/index.js";
import {
  assertNoEditsSinceBaseline,
  baselinePath,
  flagDir,
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

  it("runs only the configured command when a project configures one of the two", async () => {
    const ctx = projectContext("dotnet", tmp, { name: "api", build: `node -e ""` });
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
    expect(run.durationMs).toBeLessThan(5000);
    expect(fs.readFileSync(log, "utf8")).toContain("flagrm: error: timed out after 0.5s");
  });

  it("reads the JUnit results a test command writes into testResults", async () => {
    fs.mkdirSync(path.join(tmp, "web"));
    const junit = `<testsuite><testcase classname="A" name="one"/><testcase classname="A" name="two"><failure/></testcase></testsuite>`;
    const ctx = projectContext("angular", path.join(tmp, "web"), {
      name: "web",
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
