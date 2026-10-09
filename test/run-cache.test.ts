import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addNames, discoverNames, flagDir, writeBaseline } from "../src/core/baseline.js";
import { loadConfig } from "../src/core/config.js";
import { gitState } from "../src/core/git.js";
import { stopDecision } from "../src/core/hook.js";
import { resolveProjects } from "../src/core/registry.js";
import { baselineRuns, findRuns, plannedRuns, reusedNote, runsKey, runsPath, saveRuns } from "../src/core/run-cache.js";
import { type VerifyOptions, verifyFlag } from "../src/core/verify/index.js";

// A generic project whose build and test append to a counter outside the repo,
// so a test can tell whether the commands ran or were reused.

let tmp: string;
let counter: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();
const commit = (message: string) => {
  git("add", "-A");
  // A project doesn't commit its test result files; the key resets them to HEAD, so a committed one would change it.
  git("rm", "--cached", "-q", "--ignore-unmatch", "junit.xml");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message);
};
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};
const ran = () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").split("\n").filter(Boolean) : []);
const workspace = () => resolveProjects(loadConfig({ quiet: true }, tmp));

const CONFIG = [
  "projects:",
  "  - name: app",
  "    adapter: generic",
  "    path: .",
  '    globs: ["**/*.txt"]',
  "    methods: [isEnabled]",
  "    build: node run.cjs build",
  "    test: node run.cjs test",
  "    testResults: junit.xml",
  'exclude: ["gen/**"]',
  "",
].join("\n");

const RUN = [
  'const fs = require("node:fs");',
  'fs.appendFileSync(process.env.FLAGRM_TEST_COUNTER, process.argv[2] + "\\n");',
  'if (process.argv[2] === "test") fs.writeFileSync("junit.xml", \'<testsuite><testcase classname="A" name="works"/></testsuite>\');',
  "",
].join("\n");

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-runs-")));
  counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-counter-")), "count");
  process.env.FLAGRM_TEST_COUNTER = counter;
  write("flagrm.config.yaml", CONFIG);
  write("run.cjs", RUN);
  write("app.txt", "hello\n");
  write(".gitignore", ".flagrm/\n");
  git("init", "-q");
  commit("init");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.dirname(counter), { recursive: true, force: true });
});

/** Save the runs a full run produces now, as a passing verify of `flag` would. */
async function savedVerify(flag: string): Promise<string> {
  const projects = workspace();
  const key = runsKey(tmp, projects) as string;
  const runs = await baselineRuns(tmp, flag, projects, false);
  saveRuns(tmp, flag, projects, key, runs);
  return key;
}

describe("run cache", () => {
  it("reuses a saved set for the next flag's baseline on the committed tree, copying the logs", async () => {
    write("app.txt", "removed\n");
    await savedVerify("FlagA");
    expect(ran()).toEqual(["build", "test"]);
    commit("remove FlagA");
    const runs = await baselineRuns(tmp, "FlagB", workspace());
    expect(ran()).toEqual(["build", "test"]);
    expect(runs.map((r) => r.reused?.flag)).toEqual(["FlagA", "FlagA"]);
    const buildLog = path.join(flagDir(tmp, "FlagB"), "app.build.log");
    expect(runs[0].log).toBe(buildLog);
    expect(fs.readFileSync(buildLog, "utf8")).toContain("node run.cjs build");
    expect(runs[1].results?.names.length).toBe(1);
  });

  it("ignores changes under exclude and to the test results file", async () => {
    const key = await savedVerify("FlagA");
    write("gen/graph.json", "{}");
    write("junit.xml", "<testsuite/>");
    expect(runsKey(tmp, workspace())).toBe(key);
  });

  it("doesn't reuse after an edit, a command change or with reuse off", async () => {
    await savedVerify("FlagA");
    write("app.txt", "edited\n");
    await baselineRuns(tmp, "FlagB", workspace());
    expect(ran()).toEqual(["build", "test", "build", "test"]);
    write("app.txt", "hello\n");
    write("flagrm.config.yaml", CONFIG.replace("run.cjs build", "run.cjs build --release"));
    await baselineRuns(tmp, "FlagB", workspace());
    expect(ran()).toHaveLength(6);
    write("flagrm.config.yaml", CONFIG);
    await baselineRuns(tmp, "FlagB", workspace(), false);
    expect(ran()).toHaveLength(8);
  });

  it("never saves a run set with a setup problem", async () => {
    const projects = workspace();
    const runs = await baselineRuns(tmp, "FlagA", projects, false);
    runs[0].failure = { kind: "environment", message: "Docker isn't running" };
    saveRuns(tmp, "FlagA", projects, runsKey(tmp, projects) as string, runs);
    expect(fs.existsSync(runsPath(tmp, "FlagA"))).toBe(false);
  });

  it("skips a saved set from another flagrm version, a garbled file or a missing log", async () => {
    const key = await savedVerify("FlagA");
    const projects = workspace();
    const needed = plannedRuns(projects, ["build", "test"]);
    expect(findRuns(tmp, projects, key, needed)).toBeDefined();
    const file = runsPath(tmp, "FlagA");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...saved, flagrmVersion: "0.0.1-old" }));
    expect(findRuns(tmp, projects, key, needed)).toBeUndefined();
    fs.writeFileSync(file, "{ not json");
    expect(findRuns(tmp, projects, key, needed)).toBeUndefined();
    fs.writeFileSync(file, JSON.stringify(saved));
    fs.rmSync(saved.runs[0].log);
    expect(findRuns(tmp, projects, key, needed)).toBeUndefined();
  });

  it("plans nothing without commands, so nothing is looked up", () => {
    write("flagrm.config.yaml", CONFIG.replace("node run.cjs build", "false").replace("node run.cjs test", "false"));
    expect(plannedRuns(workspace(), ["build", "test"])).toEqual([]);
  });

  it("describes reused runs with their age", () => {
    const reused = { flag: "FlagA", createdAt: "2026-10-10T10:00:00.000Z" };
    expect(
      reusedNote(
        [
          { check: "build", reused },
          { check: "test", reused },
        ],
        "2026-10-10T10:03:00.000Z",
      ),
    ).toBe("build and tests reused from FlagA's verify (same tree and commands, 3 min ago; --no-reuse to run them)");
    expect(reusedNote([{ check: "build", reused }], "2026-10-10T10:00:20.000Z")).toBe(
      "build reused from FlagA's verify (same tree and commands, under a minute ago; --no-reuse to run them)",
    );
    expect(reusedNote([{ check: "build" }], "2026-10-10T10:00:00.000Z")).toBeUndefined();
  });
});

describe("verify with saved runs", () => {
  async function baseline(flag: string) {
    const projects = workspace();
    const checks = await baselineRuns(tmp, flag, projects);
    writeBaseline(tmp, flag, projects, gitState(tmp), checks, await discoverNames(projects, flag));
  }
  const verify = async (flag: string, options: VerifyOptions = {}) =>
    (await verifyFlag(tmp, workspace(), flag, options)).report;

  it("reuses its own passing runs, recomputes the checks, and the Stop hook accepts it", async () => {
    await baseline("FlagA");
    write("app.txt", "removed\n");
    expect((await verify("FlagA")).status).toBe("pass");
    expect(ran()).toHaveLength(4);
    const again = await verify("FlagA");
    expect(ran()).toHaveLength(4);
    expect(again.status).toBe("pass");
    expect(again.runs.map((r) => r.reused?.flag)).toEqual(["FlagA", "FlagA"]);
    expect(stopDecision(tmp, {})).toEqual({ block: false });
    addNames(tmp, "FlagA", [{ name: "removed", kind: "wrapper", source: "agent" }]);
    const failed = await verify("FlagA");
    expect(ran()).toHaveLength(4);
    expect(failed.checks.find((c) => c.id === "leftovers")?.status).toBe("fail");
    expect(fs.existsSync(runsPath(tmp, "FlagA"))).toBe(false);
  });

  it("chains flags: the next baseline reuses the previous flag's verify after the commit", async () => {
    await baseline("FlagA");
    write("app.txt", "removed\n");
    await verify("FlagA");
    commit("remove FlagA");
    await baseline("FlagB");
    expect(ran()).toHaveLength(4);
  });

  it("saves nothing for a failing verify or one with --skip, and runs again with reuse off", async () => {
    await baseline("FlagA");
    write("app.txt", "removed\n");
    await verify("FlagA", { skip: ["dead-code"] });
    expect(fs.existsSync(runsPath(tmp, "FlagA"))).toBe(false);
    await verify("FlagA");
    await verify("FlagA", { reuse: false });
    expect(ran()).toHaveLength(8);
  });

  it("keeps the saved runs through a quick verify that runs no commands", async () => {
    await baseline("FlagA");
    write("app.txt", "removed\n");
    await verify("FlagA");
    await verify("FlagA", { skip: ["build", "tests"] });
    expect(fs.existsSync(runsPath(tmp, "FlagA"))).toBe(true);
  });
});
