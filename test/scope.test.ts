import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SetupProbes, satisfiesSdk, sdkProblem } from "../src/adapters/dotnet/setup.js";
import { loadConfig } from "../src/core/config.js";
import { runDoctor } from "../src/core/doctor.js";
import { resolveProjects } from "../src/core/registry.js";
import { pointAt, setupReport, writeScope } from "../src/core/scope.js";

let tmp: string;
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};
const probes = (over: Partial<SetupProbes> = {}): SetupProbes => ({
  installedSdks: () => ["8.0.404", "9.0.100"],
  onPath: () => false,
  dockerRunning: () => false,
  ...over,
});

const csproj = (refs: string[] = [], extra = "") =>
  `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n${refs.map((r) => `    <ProjectReference Include="${r}" />\n`).join("")}  </ItemGroup>\n${extra}</Project>\n`;

const PROJECTS: Record<string, string> = {
  "src/Core/Core.csproj": csproj(),
  "src/Api/Api.csproj": csproj(["..\\Core\\Core.csproj"]),
  "util/RustSdk/RustSdk.csproj": csproj(
    [],
    '  <Target Name="Rust"><Exec Command="cargo build --release" /></Target>\n',
  ),
  "util/Seeder/Seeder.csproj": csproj(["..\\RustSdk\\RustSdk.csproj", "..\\..\\src\\Core\\Core.csproj"]),
  "util/DbSeederUtility/DbSeederUtility.csproj": csproj(["..\\Seeder\\Seeder.csproj"]),
  "test/Api.Test/Api.Test.csproj": csproj(["..\\..\\src\\Api\\Api.csproj"]),
  "test/IntegrationTestCommon/IntegrationTestCommon.csproj": csproj(
    [],
    '  <ItemGroup><PackageReference Include="Testcontainers.MsSql" Version="4.0.0" /></ItemGroup>\n',
  ),
  "test/Api.IntegrationTest/Api.IntegrationTest.csproj": csproj([
    "..\\IntegrationTestCommon\\IntegrationTestCommon.csproj",
  ]),
};

const CONFIG = `# my comment stays
projects:
  - name: api
    adapter: dotnet
    path: .
    build: dotnet build server.sln --no-incremental # build all
    test: dotnet test server.sln --logger trx
`;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-scope-")));
  for (const [rel, text] of Object.entries(PROJECTS)) write(rel, text);
  write(
    "server.sln",
    `${Object.keys(PROJECTS)
      .map(
        (rel, i) =>
          `Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "${path.basename(rel, ".csproj")}", "${rel.replace(/\//g, "\\")}", "{0000000${i}}"\nEndProject\n`,
      )
      .join("")}Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "src", "src", "{F}"\nEndProject\n`,
  );
  write("flagrm.config.yaml", CONFIG);
  execFileSync("git", ["init", "-q"], { cwd: tmp });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const workspace = () => resolveProjects(loadConfig({}, tmp));

describe("satisfiesSdk", () => {
  it.each([
    ["8.0.105", "8.0.100", "latestPatch", true],
    ["8.0.200", "8.0.100", "latestPatch", false],
    ["8.0.200", "8.0.100", "latestFeature", true],
    ["8.0.099", "8.0.100", "latestFeature", false],
    ["9.0.100", "8.0.100", "latestFeature", false],
    ["8.1.100", "8.0.100", "minor", true],
    ["10.0.101", "8.0.100", "latestMajor", true],
    ["8.0.101", "8.0.100", "disable", false],
    ["8.0.100", "8.0.100", "disable", true],
  ])("%s for %s with rollForward %s: %s", (installed, requested, rollForward, ok) => {
    expect(satisfiesSdk(installed, requested, rollForward)).toBe(ok);
  });
});

describe("sdkProblem", () => {
  it("names the requested SDK, the policy and what is installed", () => {
    write("global.json", JSON.stringify({ sdk: { version: "10.0.100", rollForward: "latestFeature" } }));
    expect(sdkProblem(tmp, probes(), tmp)).toBe(
      "global.json requests .NET SDK 10.0.100 (rollForward: latestFeature); installed: 8.0.404, 9.0.100. " +
        "Install a matching SDK or change global.json",
    );
    expect(sdkProblem(tmp, probes({ installedSdks: () => ["10.0.401"] }), tmp)).toBeUndefined();
  });

  it("says nothing without a global.json, and defaults rollForward to latestPatch", () => {
    expect(sdkProblem(tmp, probes({ installedSdks: () => [] }), tmp)).toBeUndefined();
    write("global.json", JSON.stringify({ sdk: { version: "8.0.100" } }));
    expect(sdkProblem(tmp, probes(), tmp)).toContain("(rollForward: latestPatch)");
  });
});

describe("setupReport", () => {
  it("leaves out what runs cargo or uses Testcontainers, and everything that references those", () => {
    const [api] = setupReport(workspace(), tmp, probes());
    expect(api.setup?.problems).toEqual([
      "`cargo` is not installed, and util/RustSdk/RustSdk.csproj runs it to build",
      "Docker is not running, and test/IntegrationTestCommon/IntegrationTestCommon.csproj uses Testcontainers",
    ]);
    expect(api.setup?.leaveOut.map((l) => `${l.entry}: ${l.reason}`)).toEqual([
      "util\\RustSdk\\RustSdk.csproj: runs `cargo`, which is not installed",
      "util\\Seeder\\Seeder.csproj: references RustSdk.csproj",
      "util\\DbSeederUtility\\DbSeederUtility.csproj: references Seeder.csproj",
      "test\\IntegrationTestCommon\\IntegrationTestCommon.csproj: uses Testcontainers, and Docker is not running",
      "test\\Api.IntegrationTest\\Api.IntegrationTest.csproj: references IntegrationTestCommon.csproj",
    ]);
  });

  it("leaves nothing out when the machine has cargo and Docker", () => {
    const [api] = setupReport(workspace(), tmp, probes({ onPath: () => true, dockerRunning: () => true }));
    expect(api.setup).toMatchObject({ problems: [], leaveOut: [] });
  });
});

describe("writeScope", () => {
  it("writes flagrm.slnf, excludes it from git and points build and test at it, keeping the config's comments", () => {
    const projects = workspace();
    const steps = writeScope(setupReport(projects, tmp, probes()), projects, tmp, path.join(tmp, "flagrm.config.yaml"));
    expect(steps.map((s) => `${s.status} ${s.path}`)).toEqual([
      "created flagrm.slnf",
      "updated .git/info/exclude",
      "updated flagrm.config.yaml",
    ]);
    const slnf = JSON.parse(fs.readFileSync(path.join(tmp, "flagrm.slnf"), "utf8"));
    expect(slnf.solution).toEqual({
      path: "server.sln",
      projects: ["src\\Core\\Core.csproj", "src\\Api\\Api.csproj", "test\\Api.Test\\Api.Test.csproj"],
    });
    expect(fs.readFileSync(path.join(tmp, ".git", "info", "exclude"), "utf8")).toContain("\n/flagrm.slnf\n");
    const config = fs.readFileSync(path.join(tmp, "flagrm.config.yaml"), "utf8");
    expect(config).toContain("# my comment stays");
    expect(config).toContain("build: dotnet build flagrm.slnf --no-incremental # build all");
    expect(config).toContain("test: dotnet test flagrm.slnf --logger trx");

    // Again, now through flagrm.slnf: the same solution is checked and nothing changes.
    const again = workspace();
    const second = writeScope(setupReport(again, tmp, probes()), again, tmp, path.join(tmp, "flagrm.config.yaml"));
    expect(second.map((s) => s.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
  });

  it("changes nothing when nothing has to be left out", () => {
    const projects = workspace();
    const all = probes({ onPath: () => true, dockerRunning: () => true });
    expect(writeScope(setupReport(projects, tmp, all), projects, tmp, path.join(tmp, "flagrm.config.yaml"))).toEqual(
      [],
    );
    expect(fs.readFileSync(path.join(tmp, "flagrm.config.yaml"), "utf8")).toBe(CONFIG);
  });
});

describe("pointAt", () => {
  it("replaces the solution a command names, or adds the filter after dotnet build/test", () => {
    expect(pointAt("dotnet test server.sln --logger trx", "flagrm.slnf")).toBe("dotnet test flagrm.slnf --logger trx");
    expect(pointAt('dotnet build "my server.slnx" -c Release', "flagrm.slnf")).toBe(
      "dotnet build flagrm.slnf -c Release",
    );
    expect(pointAt("dotnet build ../x.slnx -c Release", "../flagrm.slnf")).toBe(
      "dotnet build ../flagrm.slnf -c Release",
    );
    expect(pointAt("dotnet test --logger trx", "flagrm.slnf")).toBe("dotnet test flagrm.slnf --logger trx");
  });
});

describe("doctor", () => {
  it("fails on a missing SDK and warns about cargo and Docker, pointing at flagrm scope", async () => {
    write("global.json", JSON.stringify({ sdk: { version: "10.0.100" } }));
    const report = await runDoctor(tmp, { probes: probes() });
    const setup = report.checks.filter((c) => /SDK|cargo/.test(c.message)).map((c) => `${c.status} ${c.message}`);
    expect(setup).toEqual([
      expect.stringMatching(/^fail api: global\.json requests \.NET SDK 10\.0\.100/),
      expect.stringMatching(
        /^warn api: `cargo` is not installed.*; Docker is not running.*`flagrm scope` shows the 5 projects/,
      ),
    ]);
  });
});
