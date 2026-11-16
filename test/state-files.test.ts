import { describe, expect, it } from "vitest";
import { baselineProblem, isConfigSnapshot, isSavedRuns } from "../src/core/state-files.js";

const valid = {
  schemaVersion: 8,
  flag: "NewCheckout",
  createdAt: "2026-11-15T10:00:00.000Z",
  projects: [{ name: "api", adapter: "dotnet" }],
  git: {
    sha: "a".repeat(40),
    dirty: true,
    dirtyFiles: ["a.cs"],
    dirtyHashes: { "a.cs": "b".repeat(40), "b.cs": null },
  },
  names: [
    { name: "NewCheckout", kind: "literal", source: "discovery" },
    { name: "useNew", kind: "wrapper", source: "agent", file: "src/a.ts" },
  ],
  checks: [
    {
      project: "api",
      check: "test",
      command: "dotnet test",
      exitCode: 0,
      durationMs: 1200,
      log: "/tmp/api.test.log",
      results: { total: 1, passed: 1, failed: 0, skipped: 0, names: ["T.A"], failedNames: [], files: ["r.trx"] },
    },
  ],
  config: {
    file: { path: "flagrm.config.yaml", text: "projects: []\n" },
    projects: [{ name: "api", test: { command: "dotnet test", files: [{ path: "a.slnf", sha256: "c" }] } }],
  },
};

const without = (key: string) => Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));

describe("baselineProblem", () => {
  it("accepts what flagrm writes, and a version 6 file without the optional fields", () => {
    expect(baselineProblem(valid)).toBeUndefined();
    const { checks: _c, config: _f, ...minimal } = valid;
    expect(baselineProblem({ ...minimal, schemaVersion: 6, git: { sha: null, dirty: false } })).toBeUndefined();
  });

  it("names the first field that is missing or of the wrong type", () => {
    expect(baselineProblem(without("names"))).toBe("names is missing");
    expect(baselineProblem({ ...valid, names: "NewCheckout" })).toBe("names must be an array, not a string");
    expect(baselineProblem({ ...valid, names: [{ name: "X", kind: "macro", source: "agent" }] })).toBe(
      "names[0].kind must be one of literal, alias, wrapper",
    );
    expect(baselineProblem({ ...valid, git: { sha: 1, dirty: false } })).toBe("git.sha must be a string, not a number");
    expect(baselineProblem({ ...valid, checks: [{ ...valid.checks[0], exitCode: null }] })).toBe(
      "checks[0].exitCode must be a number, not null",
    );
    expect(baselineProblem({ ...valid, config: { projects: [{}] } })).toBe("config.projects[0].name is missing");
    expect(baselineProblem({ ...valid, git: { ...valid.git, dirtyHashes: { "a.cs": 3 } } })).toBe(
      "git.dirtyHashes.a.cs must be a string, not a number",
    );
  });

  it("refuses a file that isn't an object", () => {
    expect(baselineProblem(null)).toBe("the file must be an object, not null");
    expect(baselineProblem([])).toBe("the file must be an object, not an array");
  });

  it("ignores fields it doesn't know, so a newer minor's additions still read", () => {
    expect(baselineProblem({ ...valid, futureField: { anything: true } })).toBeUndefined();
  });
});

describe("isConfigSnapshot", () => {
  it("accepts a snapshot and refuses a file entry without its text", () => {
    expect(isConfigSnapshot(valid.config)).toBe(true);
    expect(isConfigSnapshot({ ...valid.config, file: { path: "flagrm.config.yaml" } })).toBe(false);
    expect(isConfigSnapshot(undefined)).toBe(false);
  });
});

describe("isSavedRuns", () => {
  const saved = {
    schemaVersion: 8,
    flagrmVersion: "1.0.0",
    flag: "NewCheckout",
    createdAt: "2026-11-15T10:00:00.000Z",
    key: "abc",
    commands: valid.config.projects,
    runs: valid.checks,
  };

  it("accepts a saved set and refuses one with a malformed run", () => {
    expect(isSavedRuns(saved)).toBe(true);
    expect(isSavedRuns({ ...saved, runs: [null] })).toBe(false);
    expect(isSavedRuns({ ...saved, runs: [{ ...valid.checks[0], check: "deploy" }] })).toBe(false);
    expect(isSavedRuns({ ...saved, key: undefined })).toBe(false);
  });
});
