import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKEND_ATTRIBUTES, DEFAULT_BACKEND_METHODS, loadConfig } from "../src/core/config.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffr-config-"));
  fs.mkdirSync(path.join(tmp, "backend"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(contents: string): void {
  fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), contents, "utf8");
}

describe("loadConfig — config lookup", () => {
  it("finds the config in a parent directory of the repository, resolving paths against it", () => {
    fs.mkdirSync(path.join(tmp, ".git"));
    writeConfig("backend: ./backend\n");
    const sub = path.join(tmp, "backend", "src");
    fs.mkdirSync(sub);
    const config = loadConfig({}, sub);
    expect(config.projects.map((p) => p.path)).toEqual([path.join(tmp, "backend")]);
  });

  it("does not look above the repository root, or above cwd outside a repository", () => {
    writeConfig("backend: ./backend\n");
    const sub = path.join(tmp, "backend");
    expect(() => loadConfig({}, sub)).toThrow(/No projects configured/);
    fs.mkdirSync(path.join(sub, ".git"));
    expect(() => loadConfig({}, sub)).toThrow(/No projects configured/);
  });
});

describe("loadConfig — exclude/include globs", () => {
  it("defaults exclude/include to empty arrays", () => {
    writeConfig("backend: ./backend\n");
    const config = loadConfig({}, tmp);
    expect(config.exclude).toEqual([]);
    expect(config.include).toEqual([]);
  });

  it("reads exclude/include from the config file", () => {
    writeConfig(["backend: ./backend", "exclude:", "  - '**/Migrations/**'", "include:", "  - '**/*.g.cs'"].join("\n"));
    const config = loadConfig({}, tmp);
    expect(config.exclude).toEqual(["**/Migrations/**"]);
    expect(config.include).toEqual(["**/*.g.cs"]);
  });

  it("unions config-file and CLI exclude/include rather than one overriding the other", () => {
    writeConfig(["backend: ./backend", "exclude:", "  - '**/Migrations/**'"].join("\n"));
    const config = loadConfig({ exclude: ["**/*.designer.cs"], include: ["**/*.g.cs"] }, tmp);
    expect(config.exclude).toEqual(["**/Migrations/**", "**/*.designer.cs"]);
    expect(config.include).toEqual(["**/*.g.cs"]);
  });
});

describe("loadConfig — unknown key warning", () => {
  it("warns on stderr about an unrecognized top-level config key", () => {
    writeConfig(["backend: ./backend", "frontEnd: ./oops"].join("\n"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig({}, tmp);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown key "frontEnd"'));
    spy.mockRestore();
  });

  it("does not warn when every key is recognized", () => {
    writeConfig(["backend: ./backend", "exclude:", "  - '**/bin/**'"].join("\n"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig({}, tmp);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("loadConfig — projects", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tmp, "web"));
  });

  it("converts legacy frontend/backend keys into named projects", () => {
    writeConfig(["frontend: ./web", "backend: ./backend", "frontendMethods: [isEnabled, watch]"].join("\n"));
    const { projects } = loadConfig({}, tmp);
    expect(projects).toEqual([
      {
        name: "frontend",
        adapter: "angular",
        path: path.join(tmp, "web"),
        methods: ["isEnabled", "watch"],
        attributes: [],
      },
      {
        name: "backend",
        adapter: "dotnet",
        path: path.join(tmp, "backend"),
        methods: DEFAULT_BACKEND_METHODS,
        attributes: DEFAULT_BACKEND_ATTRIBUTES,
      },
    ]);
  });

  it("reads projects with build/test settings, resolving paths relative to the config file", () => {
    writeConfig(
      [
        "projects:",
        "  - name: api",
        "    adapter: dotnet",
        "    path: ./backend",
        "    build: dotnet build",
        "    test: dotnet test --logger trx",
        "    testResults: ./backend/TestResults/*.trx",
        "    globs: ['**/*.cs']",
        "  - name: web",
        "    adapter: angular",
        "    path: ./web",
        "    methods: [isEnabled]",
      ].join("\n"),
    );
    const { projects } = loadConfig({}, tmp);
    expect(projects[0]).toEqual({
      name: "api",
      adapter: "dotnet",
      path: path.join(tmp, "backend"),
      build: "dotnet build",
      test: "dotnet test --logger trx",
      testResults: path.join(tmp, "backend", "TestResults", "*.trx"),
      globs: ["**/*.cs"],
      methods: DEFAULT_BACKEND_METHODS,
      attributes: DEFAULT_BACKEND_ATTRIBUTES,
    });
    expect(projects[1]).toMatchObject({ name: "web", adapter: "angular", methods: ["isEnabled"], attributes: [] });
  });

  it("uses frontendMethods/backendMethods as adapter defaults for projects", () => {
    writeConfig(
      ["frontendMethods: [watch]", "projects:", "  - { name: web, adapter: angular, path: ./web }"].join("\n"),
    );
    expect(loadConfig({}, tmp).projects[0].methods).toEqual(["watch"]);
  });

  it("lets --frontend/--backend replace the project of the same name", () => {
    fs.mkdirSync(path.join(tmp, "other"));
    writeConfig("backend: ./backend\n");
    const { projects } = loadConfig({ backend: "other" }, tmp);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "backend", adapter: "dotnet", path: path.join(tmp, "other") });
  });

  it("appends a CLI --frontend project to the configured projects", () => {
    writeConfig("projects:\n  - { name: api, adapter: dotnet, path: ./backend }\n");
    const { projects } = loadConfig({ frontend: "web" }, tmp);
    expect(projects.map((p) => p.name)).toEqual(["api", "frontend"]);
  });

  const invalid: Array<[string, string, RegExp]> = [
    ["no projects", "exclude: []\n", /No projects configured/],
    ["a missing name", "projects:\n  - { adapter: dotnet, path: ./backend }\n", /projects\[0\].*name/],
    ["an invalid name", "projects:\n  - { name: 'my api', adapter: dotnet, path: ./backend }\n", /name "my api"/],
    [
      "duplicate names",
      "projects:\n  - { name: api, adapter: dotnet, path: ./backend }\n  - { name: api, adapter: angular, path: ./web }\n",
      /Duplicate project name "api"/,
    ],
    [
      "a legacy key clashing with a project",
      "backend: ./backend\nprojects:\n  - { name: backend, adapter: dotnet, path: ./backend }\n",
      /Duplicate project name "backend"/,
    ],
    ["an unknown adapter", "projects:\n  - { name: api, adapter: rails, path: ./backend }\n", /adapter "rails"/],
    ["a missing path", "projects:\n  - { name: api, adapter: dotnet }\n", /projects\[0\].*path/],
    ["a path that doesn't exist", "projects:\n  - { name: api, adapter: dotnet, path: ./nope }\n", /does not exist/],
    ["projects that is not a list", "projects: { name: api }\n", /projects.*list/],
  ];

  for (const [name, contents, error] of invalid) {
    it(`rejects ${name}`, () => {
      writeConfig(contents);
      expect(() => loadConfig({}, tmp)).toThrow(error);
    });
  }

  it("warns about unknown keys inside a project", () => {
    writeConfig("projects:\n  - { name: api, adapter: dotnet, path: ./backend, buidl: make }\n");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig({}, tmp);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown key "buidl" in project "api"'));
    spy.mockRestore();
  });
});

describe("loadConfig — top-level value types", () => {
  it.each([
    ["exclude", 'exclude: "**/gen/**"'],
    ["include", "include: '**/*.g.cs'"],
    ["frontendMethods", "frontendMethods: isOn"],
    ["backendMethods", "backendMethods: 3"],
    ["backendAttributes", "backendAttributes: FeatureGate"],
  ])("rejects a %s that is not a list of strings", (key, line) => {
    writeConfig(`backend: ./backend\n${line}\n`);
    expect(() => loadConfig({}, tmp)).toThrow(`${key} must be a list of strings.`);
  });

  it("rejects a backend path that is not a string", () => {
    writeConfig("backend: [./backend]\n");
    expect(() => loadConfig({}, tmp)).toThrow("backend must be a non-empty string.");
  });

  it("reads a positive timeout and rejects any other", () => {
    writeConfig("projects:\n  - name: api\n    adapter: dotnet\n    path: ./backend\n    timeout: 600\n");
    expect(loadConfig({}, tmp).projects[0].timeout).toBe(600);
    writeConfig("projects:\n  - name: api\n    adapter: dotnet\n    path: ./backend\n    timeout: 10m\n");
    expect(() => loadConfig({}, tmp)).toThrow("projects[0].timeout must be a positive number of seconds.");
  });
});
