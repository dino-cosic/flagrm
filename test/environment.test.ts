import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCheck } from "../src/core/baseline.js";
import { environmentProblem } from "../src/core/environment.js";
import { projectContext } from "./support/projects.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-env-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// What `dotnet build` prints (exit 155) when global.json asks for an SDK that isn't
// installed. The installed SDKs go to stdout and land after the message in a combined log.
const sdkLog = (globalJson: string) => `$ dotnet build
The command could not be loaded, possibly because:
  * You intended to execute a .NET application:
      The application 'build' does not exist or is not a managed .dll or .exe.
  * You intended to execute a .NET SDK command:
      A compatible .NET SDK was not found.

Requested SDK version: 8.0.100
global.json file: ${globalJson}

Installed SDKs:

Install the [8.0.100] .NET SDK or update [${globalJson}] to match an installed SDK.

Learn about SDK resolution:
https://aka.ms/dotnet/sdk-not-found
10.0.101 [/usr/local/share/dotnet/sdk]
10.0.401 [/usr/local/share/dotnet/sdk]
`;

describe("environmentProblem", () => {
  it("names the requested and installed .NET SDKs, with global.json's rollForward", () => {
    const globalJson = path.join(tmp, "global.json");
    fs.writeFileSync(globalJson, JSON.stringify({ sdk: { version: "8.0.100", rollForward: "latestFeature" } }));
    expect(environmentProblem(sdkLog(globalJson), tmp)).toBe(
      ".NET SDK not found: global.json requests 8.0.100, rollForward: latestFeature; installed: 10.0.101, 10.0.401. " +
        "Install that SDK or change global.json",
    );
  });

  it("names a command a build step couldn't find and the project that runs it", () => {
    const log = `  sh: cargo: command not found
${tmp}/src/RustSdk/RustSdk.csproj(23,5): error MSB3073: The command "cargo build --release" exited with code 127.
${tmp}/src/RustSdk/RustSdk.csproj(23,5): error MSB3073: The command "cargo build --release" exited with code 127.`;
    expect(environmentProblem(log, tmp)).toBe(
      "`cargo` is not installed or not on PATH (needed by src/RustSdk/RustSdk.csproj)",
    );
  });

  it("recognizes command-not-found from other shells", () => {
    expect(environmentProblem("/bin/sh: 1: cargo: not found", tmp)).toContain("`cargo` is not installed");
    expect(environmentProblem("zsh: command not found: cargo", tmp)).toContain("`cargo` is not installed");
    expect(environmentProblem("'cargo' is not recognized as an internal or external command,", tmp)).toContain(
      "`cargo` is not installed",
    );
  });

  it("says Docker is not running when Testcontainers can't reach it", () => {
    const log = `[xUnit.net 00:00:01.20]     Bit.Infrastructure.IntegrationTest.DatabaseTests.Create [FAIL]
      Testcontainers.DockerUnavailableException : Docker is either not running or misconfigured. Please ensure that Docker is running.`;
    expect(environmentProblem(log, tmp)).toBe(
      "Docker is not running (Testcontainers tests need it): start Docker or leave those tests out of `test`",
    );
  });

  it("reports several problems on one line, and nothing for an ordinary failure", () => {
    const log = "sh: cargo: command not found\nCannot connect to the Docker daemon at unix:///var/run/docker.sock";
    expect(environmentProblem(log, tmp)).toMatch(/^`cargo` .*; Docker is not running/);
    expect(environmentProblem("Program.cs(3,1): error CS1002: ; expected\nBuild FAILED.", tmp)).toBeUndefined();
  });
});

describe("runCheck", () => {
  it("labels a failed run whose log shows a setup problem", async () => {
    const ctx = projectContext("generic", tmp, { name: "svc" });
    const run = await runCheck(ctx, "build", "flagrm-no-such-command-xyz", path.join(tmp, "build.log"));
    expect(run.exitCode).not.toBe(0);
    expect(run.failure).toEqual({
      kind: "environment",
      message: "`flagrm-no-such-command-xyz` is not installed or not on PATH",
    });
  });

  it("leaves an ordinary failure unlabeled", async () => {
    const ctx = projectContext("generic", tmp, { name: "svc" });
    const run = await runCheck(ctx, "build", `node -e "process.exit(1)"`, path.join(tmp, "build.log"));
    expect(run.failure).toBeUndefined();
  });
});
