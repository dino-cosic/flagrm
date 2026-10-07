import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { configChanges, configSnapshot, lineDiff, projectCommands } from "../src/core/config-snapshot.js";
import { resolveProjects } from "../src/core/registry.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-snapshot-")));
  fs.mkdirSync(path.join(tmp, "api"));
  fs.writeFileSync(path.join(tmp, "api", "flagrm.slnf"), '{"solution":{"projects":["A.csproj"]}}');
  fs.writeFileSync(path.join(tmp, "api", "ci.runsettings"), "<RunSettings/>");
  fs.writeFileSync(path.join(tmp, "api", "Api.csproj"), "<Project/>");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CONFIG = `projects:
  - name: api
    adapter: dotnet
    path: ./api
    build: dotnet build flagrm.slnf --no-incremental
    test: dotnet test flagrm.slnf --settings ci.runsettings --logger trx
    testResults: ./api/TestResults/*.trx
`;

function snapshot(text = CONFIG) {
  fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), text);
  return configSnapshot(resolveProjects(loadConfig({}, tmp)));
}

describe("configSnapshot", () => {
  it("records the config text, each resolved command and the files it names, but not project files", () => {
    const s = snapshot(CONFIG.replace("build: dotnet build flagrm.slnf", "build: dotnet build Api.csproj"));
    expect(s.file?.path).toBe("flagrm.config.yaml");
    expect(s.file?.text).toContain("ci.runsettings");
    const [api] = s.projects;
    expect(api.build).toEqual({ command: "dotnet build Api.csproj --no-incremental", files: [] });
    expect(api.test?.files.map((f) => f.path)).toEqual(["api/ci.runsettings", "api/flagrm.slnf"]);
    expect(api.testResults).toBe("api/TestResults/*.trx");
  });
});

describe("configChanges", () => {
  it("finds nothing without a baseline snapshot, or when nothing changed", () => {
    expect(configChanges(undefined, snapshot())).toEqual([]);
    expect(configChanges(snapshot(), snapshot())).toEqual([]);
  });

  it("reports a changed test command against tests, without a separate config-file change", () => {
    const before = snapshot();
    const now = snapshot(CONFIG.replace("--logger trx", "--logger trx --filter Category!=Slow"));
    expect(configChanges(before, now)).toEqual([
      {
        check: "tests",
        project: "api",
        message:
          "test command changed since the baseline: `dotnet test flagrm.slnf --settings ci.runsettings --logger trx` → " +
          "`dotnet test flagrm.slnf --settings ci.runsettings --logger trx --filter Category!=Slow`",
      },
    ]);
  });

  it("reports a changed file a command names, against each command naming it", () => {
    const before = snapshot();
    fs.writeFileSync(path.join(tmp, "api", "flagrm.slnf"), '{"solution":{"projects":[]}}');
    expect(configChanges(before, snapshot()).map((c) => `${c.check}: ${c.message}`)).toEqual([
      "build: api/flagrm.slnf, named by the build command, changed since the baseline",
      "tests: api/flagrm.slnf, named by the test command, changed since the baseline",
    ]);
  });

  it("reports a changed testResults pattern", () => {
    const before = snapshot();
    const now = snapshot(CONFIG.replace("./api/TestResults/*.trx", "./api/out/*.trx"));
    expect(configChanges(before, now)).toMatchObject([
      { check: "tests", message: "testResults changed since the baseline: `api/TestResults/*.trx` → `api/out/*.trx`" },
    ]);
  });

  it("reports any other config change against leftovers, with the changed lines", () => {
    const before = snapshot();
    const now = snapshot(`${CONFIG}exclude:\n  - "**/Migrations/**"\n`);
    expect(configChanges(before, now)).toEqual([
      {
        check: "leftovers",
        message: "flagrm.config.yaml changed since the baseline, which changes what is scanned",
        details: ["+ exclude:", '+   - "**/Migrations/**"'],
      },
    ]);
  });
});

describe("configChanges and tools:", () => {
  it("ignores a change to tools:, which only says which agents init sets up", () => {
    const before = snapshot();
    const now = snapshot(`tools: [claude-code]\n${CONFIG}`);
    expect(configChanges(before, now)).toEqual([]);
  });
});

describe("lineDiff", () => {
  it("lists removed and added lines in order, capped", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual(["- b", "+ B", "+ d"]);
    expect(lineDiff("x\n", "1\n2\n3\n", 2)).toEqual(["- x", "+ 1", "… 2 more changed lines"]);
  });
});

describe("projectCommands", () => {
  const resolve = (text: string) => {
    fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), text);
    const [{ adapter, ctx }] = resolveProjects(loadConfig({}, tmp));
    return projectCommands(adapter, ctx);
  };
  const project = "projects:\n  - name: api\n    adapter: dotnet\n    path: ./api\n";

  it("uses every adapter default when nothing is configured, TRX into .flagrm/test-results", () => {
    const c = resolve(project);
    expect(c.build).toBe("dotnet build --no-incremental");
    expect(c.test).toBe('dotnet test --logger trx --results-directory "../.flagrm/test-results/api"');
    expect(c.testResults).toBe(path.join(tmp, ".flagrm", "test-results", "api", "*.trx"));
    expect(c.defaults).toEqual(["build", "test", "testResults"]);
  });

  it("keeps the default build when only test is configured, and drops the default testResults", () => {
    const c = resolve(`${project}    test: dotnet test Api.sln\n`);
    expect(c.build).toBe("dotnet build --no-incremental");
    expect(c.test).toBe("dotnet test Api.sln");
    expect(c.testResults).toBeUndefined();
    expect(c.defaults).toEqual(["build"]);
  });

  it("turns a command off with false", () => {
    const c = resolve(`${project}    build: false\n    test: false\n`);
    expect(c).toEqual({ defaults: [] });
  });
});
