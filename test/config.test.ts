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

  it("does not warn with quiet, at the top level or in a project", () => {
    writeConfig("frontEnd: ./oops\nprojects:\n  - { name: api, adapter: dotnet, path: ./backend, tset: x }\n");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig({ quiet: true }, tmp);
    expect(spy).not.toHaveBeenCalled();
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

describe("loadConfig — commands", () => {
  const project = "projects:\n  - name: api\n    adapter: dotnet\n    path: ./backend\n";

  it("accepts false for build and test", () => {
    writeConfig(`${project}    build: false\n    test: false\n`);
    expect(loadConfig({}, tmp).projects[0]).toMatchObject({ build: false, test: false });
  });

  it("rejects true and empty commands", () => {
    writeConfig(`${project}    build: true\n`);
    expect(() => loadConfig({}, tmp)).toThrow(/projects\[0\]\.build must be a non-empty string or false/);
    writeConfig(`${project}    test: ""\n`);
    expect(() => loadConfig({}, tmp)).toThrow(/projects\[0\]\.test must be a non-empty string or false/);
  });

  it("reads lint and covers, and accepts lint: false", () => {
    writeConfig(`${project}    lint: npx eslint .\n    covers: ["src/**", "e2e/**"]\n`);
    expect(loadConfig({}, tmp).projects[0]).toMatchObject({ lint: "npx eslint .", covers: ["src/**", "e2e/**"] });
    writeConfig(`${project}    lint: false\n`);
    expect(loadConfig({}, tmp).projects[0].lint).toBe(false);
  });

  it("leaves lint and covers out when absent", () => {
    writeConfig(project);
    const p = loadConfig({}, tmp).projects[0];
    expect(p).not.toHaveProperty("lint");
    expect(p).not.toHaveProperty("covers");
  });

  it("rejects an empty lint and a covers that is not a list of strings", () => {
    writeConfig(`${project}    lint: ""\n`);
    expect(() => loadConfig({}, tmp)).toThrow(/projects\[0\]\.lint must be a non-empty string or false/);
    writeConfig(`${project}    covers: "src/**"\n`);
    expect(() => loadConfig({}, tmp)).toThrow("projects[0].covers must be a list of strings.");
  });

  it("knows lint and covers: no unknown-key warning", () => {
    writeConfig(`${project}    lint: npx eslint .\n    covers: ["src/**"]\n`);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig({}, tmp);
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining("unknown key"));
    spy.mockRestore();
  });
});

describe("loadConfig — launchdarkly", () => {
  const withLd = (lines: string[]) => writeConfig(["backend: ./backend", "launchdarkly:", ...lines].join("\n"));

  it("leaves launchdarkly undefined when the section is absent", () => {
    writeConfig("backend: ./backend\n");
    expect(loadConfig({}, tmp).launchdarkly).toBeUndefined();
  });

  it("applies the defaults to a minimal section", () => {
    withLd(["  project: shop"]);
    expect(loadConfig({}, tmp).launchdarkly).toEqual({
      project: "shop",
      baseUrl: "https://app.launchdarkly.com",
      tokenEnv: "LD_API_TOKEN",
      minDaysOn: 30,
      temporaryOnly: true,
      tags: { include: [], exclude: [] },
      map: {},
    });
  });

  it("reads every key", () => {
    withLd([
      "  project: shop",
      "  baseUrl: https://app.eu.launchdarkly.com/",
      "  tokenEnv: SHOP_LD_TOKEN",
      "  environments: [production, staging]",
      "  minDaysOn: 14",
      "  temporaryOnly: false",
      "  tags: { include: [cleanup], exclude: [permanent] }",
      "  map: { checkout-v2: NewCheckout }",
    ]);
    expect(loadConfig({}, tmp).launchdarkly).toEqual({
      project: "shop",
      baseUrl: "https://app.eu.launchdarkly.com",
      tokenEnv: "SHOP_LD_TOKEN",
      environments: ["production", "staging"],
      minDaysOn: 14,
      temporaryOnly: false,
      tags: { include: ["cleanup"], exclude: ["permanent"] },
      map: { "checkout-v2": "NewCheckout" },
    });
  });

  it("requires a project", () => {
    withLd(["  minDaysOn: 30"]);
    expect(() => loadConfig({}, tmp)).toThrow(/launchdarkly\.project is required/);
  });

  it.each(["token", "apiKey"])("rejects a %s in the file, pointing at tokenEnv", (key) => {
    withLd(["  project: shop", `  ${key}: api-123`]);
    expect(() => loadConfig({}, tmp)).toThrow(/tokenEnv/);
    expect(() => loadConfig({}, tmp)).not.toThrow(/api-123/);
  });

  it("warns about unknown keys in the section and in tags", () => {
    withLd(["  project: shop", "  minDays: 30", "  tags: { exlude: [x] }"]);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig({}, tmp);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown key "minDays" in "launchdarkly"'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('unknown key "exlude" in "launchdarkly.tags"'));
    spy.mockRestore();
  });

  it.each([
    ["temporaryOnly: yes please", "launchdarkly.temporaryOnly must be true or false."],
    ["minDaysOn: 2.5", "launchdarkly.minDaysOn must be a positive whole number of days."],
    ["minDaysOn: 0", "launchdarkly.minDaysOn must be a positive whole number of days."],
    ["environments: production", "launchdarkly.environments must be a list of strings."],
    ["environments: []", "launchdarkly.environments must name at least one environment."],
    ["map: { checkout-v2: 3 }", "launchdarkly.map must map LaunchDarkly keys to code names (strings)."],
    ["tags: [permanent]", "launchdarkly.tags must be an object"],
  ])("rejects %s", (line, message) => {
    withLd(["  project: shop", `  ${line}`]);
    expect(() => loadConfig({}, tmp)).toThrow(message);
  });

  it("rejects an http baseUrl except on a loopback host", () => {
    withLd(["  project: shop", "  baseUrl: http://ld.example.com"]);
    expect(() => loadConfig({}, tmp)).toThrow("launchdarkly.baseUrl must use https");
    for (const host of ["127.0.0.1:9", "localhost:8080", "[::1]"]) {
      withLd(["  project: shop", `  baseUrl: http://${host}`]);
      expect(loadConfig({}, tmp).launchdarkly?.baseUrl).toBe(`http://${host}`);
    }
  });
});
