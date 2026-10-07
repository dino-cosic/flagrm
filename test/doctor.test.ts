import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor, simpleCommandProgram } from "../src/core/doctor.js";
import { HOOK_COMMAND, initProject, stampSkill } from "../src/core/install.js";

let tmp: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();
const commitAll = () => {
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "setup");
};
const config = (build: string, test?: string, testResults?: string) =>
  fs.writeFileSync(
    path.join(tmp, "flagrm.config.yaml"),
    [
      "projects:",
      "  - name: svc",
      "    adapter: generic",
      "    path: .",
      "    globs: ['**/*.txt']",
      `    build: ${JSON.stringify(build)}`,
      ...(test ? [`    test: ${JSON.stringify(test)}`] : []),
      ...(testResults ? [`    testResults: ${testResults}`] : []),
      "",
    ].join("\n"),
  );
/** A build that prints `lines` and exits with `code`, through a file so no shell (sh or cmd.exe) mangles the text. */
const failingBuild = (lines: string[], code: number) => {
  fs.writeFileSync(path.join(tmp, "build.log"), `${lines.join("\n")}\n`);
  config(`node -e "process.stdout.write(require('fs').readFileSync('build.log','utf8'));process.exit(${code})"`);
};
/** A test command that writes `xml` as its JUnit results to .flagrm/r.xml (gitignored), then exits with `code`. */
const testWriting = (xml: string, code = 0) => {
  fs.writeFileSync(path.join(tmp, "r.src.xml"), xml);
  return `node -e "const fs=require('fs');fs.mkdirSync('.flagrm',{recursive:true});fs.copyFileSync('r.src.xml','.flagrm/r.xml');process.exit(${code})"`;
};
const problems = async (cwd = tmp, options = {}) =>
  (await runDoctor(cwd, options)).checks.filter((c) => c.status !== "ok").map((c) => `${c.status} ${c.message}`);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-doctor-")));
  git("init", "-q");
  initProject(tmp);
  config('node -e ""', testWriting("<testsuite/>"), "./.flagrm/r.xml");
  commitAll();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("reports no problems for a complete setup", async () => {
    expect(await problems()).toEqual([]);
    expect((await runDoctor(tmp)).status).toBe("ok");
  });

  it("fails without a config file", async () => {
    fs.rmSync(path.join(tmp, "flagrm.config.yaml"));
    expect(await problems()).toContain("fail no flagrm.config.yaml (run flagrm init)");
    expect((await runDoctor(tmp)).status).toBe("fail");
  });

  it("accepts flagrm.config.yml", async () => {
    fs.renameSync(path.join(tmp, "flagrm.config.yaml"), path.join(tmp, "flagrm.config.yml"));
    commitAll();
    expect(await problems()).toEqual([]);
  });

  it("warns that an incremental dotnet build hides existing warnings from the dead-code check", async () => {
    const dotnet = (build: string) =>
      fs.writeFileSync(
        path.join(tmp, "flagrm.config.yaml"),
        `projects:\n  - name: api\n    adapter: dotnet\n    path: .\n    build: ${build}\n    test: node -e ""\n`,
      );
    const onPath = process.env.PATH;
    // dotnet may not be installed: put a stub on PATH so doctor gets past the PATH check.
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, process.platform === "win32" ? "dotnet.cmd" : "dotnet"), "", { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${onPath}`;
    try {
      dotnet("dotnet build Shop.sln");
      expect(await problems()).toContainEqual(expect.stringMatching(/^warn api: .*--no-incremental/));
      dotnet("dotnet build Shop.sln --no-incremental");
      expect((await problems()).filter((p) => p.includes("--no-incremental"))).toEqual([]);
    } finally {
      process.env.PATH = onPath;
    }
  });

  it("fails on a project path that doesn't exist", async () => {
    fs.writeFileSync(
      path.join(tmp, "flagrm.config.yaml"),
      "projects:\n  - name: web\n    adapter: angular\n    path: ./frontend\n",
    );
    commitAll();
    expect((await problems()).some((p) => p.startsWith("fail config:") && p.includes("frontend"))).toBe(true);
  });

  it("fails on a command whose executable is not on PATH, and warns on a missing test command", async () => {
    config("definitely-not-installed-xyz build");
    commitAll();
    expect(await problems()).toEqual([
      "fail svc: `definitely-not-installed-xyz` (from `definitely-not-installed-xyz build`) is not on PATH",
      "warn svc: no test command — verify can't compare tests",
    ]);
  });

  it("warns when a test command has no testResults to compare by name", async () => {
    config('node -e ""', 'node -e ""');
    commitAll();
    expect(await problems()).toContain(
      "warn svc: test command has no testResults — verify can't compare tests by name, so a test that fails before the removal fails verify too",
    );
  });

  it("fails with --run when the test command writes no results matching testResults", async () => {
    config('node -e ""', 'node -e ""', "./out/*.xml");
    commitAll();
    expect(await problems(tmp, { run: true })).toContain(
      'fail svc: `node -e ""` wrote no test results matching out/*.xml',
    );
  });

  it("only warns with --run when tests already fail: the baseline records them as known failures", async () => {
    const test = testWriting('<testsuite><testcase classname="A" name="b"><failure/></testcase></testsuite>', 1);
    config('node -e ""', test, "./.flagrm/r.xml");
    commitAll();
    const report = await runDoctor(tmp, { run: true });
    expect(report.checks.filter((c) => c.status !== "ok").map((c) => `${c.status} ${c.message}`)).toEqual([
      `warn svc: \`${test}\`: 1 test fails already — the baseline records it as a known failure, which verify only warns about`,
    ]);
    expect(report.status).toBe("ok");
  });

  it("labels the commands that are adapter defaults", async () => {
    fs.writeFileSync(path.join(tmp, "package.json"), '{"scripts":{"build":"node -e \\"\\""}}\n');
    fs.writeFileSync(
      path.join(tmp, "flagrm.config.yaml"),
      "projects:\n  - name: svc\n    adapter: generic\n    path: .\n    test: false\n",
    );
    commitAll();
    const messages = (await runDoctor(tmp)).checks.map((c) => c.message);
    expect(messages).toContain("svc: build command `npm run build` (adapter default)");
  });

  it("runs the commands with --run and fails on a non-zero exit", async () => {
    config('node -e ""', 'node -e "process.exit(3)"');
    commitAll();
    expect((await problems(tmp, { run: true })).some((p) => p.startsWith("fail svc:") && p.includes("exit 3"))).toBe(
      true,
    );
  });

  it("shows the error lines of a failed command, not its warnings", async () => {
    const log = [
      "src/A.cs(8,9): warning CA1305: The behavior of string.Format could vary [Core.csproj]",
      "src/Api/Program.cs(12,5): error CS0103: The name 'Foo' does not exist in the current context [Api.csproj]",
      "    1 Error(s)",
      "    0 Error(s)",
    ];
    failingBuild(log, 1);
    commitAll();
    const build = (await runDoctor(tmp, { run: true })).checks.find((c) => c.message.includes("failed (exit 1"));
    expect(build?.details).toEqual([log[1]]);
  });

  it("shows a setup problem instead of the error lines", async () => {
    failingBuild(
      ['util/RustSdk/RustSdk.csproj(38,5): error MSB3073: The command "cargo build" exited with code 127.'],
      1,
    );
    commitAll();
    const build = (await runDoctor(tmp, { run: true })).checks.find((c) => c.message.includes("failed (exit 1"));
    expect(build?.details).toEqual([
      "setup problem: `cargo` is not installed or not on PATH (needed by util/RustSdk/RustSdk.csproj)",
    ]);
  });

  it("finds error lines in colored output", async () => {
    const line = "\u001b[96msrc/a.html\u001b[0m:3:5 - \u001b[91merror\u001b[0m TS2339: Property 'Role' does not exist";
    failingBuild(["noise", line, "more noise"], 1);
    commitAll();
    const build = (await runDoctor(tmp, { run: true })).checks.find((c) => c.message.includes("failed (exit 1"));
    expect(build?.details).toEqual(["src/a.html:3:5 - error TS2339: Property 'Role' does not exist"]);
  });

  it("warns that tsc alone doesn't type-check Angular templates", async () => {
    fs.writeFileSync(
      path.join(tmp, "flagrm.config.yaml"),
      'projects:\n  - name: web\n    adapter: angular\n    path: .\n    build: npx tsc -p tsconfig.json --noEmit\n    test: node -e ""\n',
    );
    commitAll();
    expect(await problems()).toContainEqual(expect.stringMatching(/^warn web: .*doesn't type-check Angular templates/));
    fs.writeFileSync(
      path.join(tmp, "flagrm.config.yaml"),
      'projects:\n  - name: web\n    adapter: angular\n    path: .\n    build: npx tsc -p tsconfig.json --noEmit && npx ngc -p src/tsconfig.app.json --noEmit\n    test: node -e ""\n',
    );
    commitAll();
    expect((await problems()).filter((p) => p.includes("Angular templates"))).toEqual([]);
  });

  it("shows the last lines of a failed command's log when none says error", async () => {
    const log = ["Requested SDK version: 10.0.103", "", "Install the [10.0.103] .NET SDK or update global.json"];
    failingBuild(log, 155);
    commitAll();
    const build = (await runDoctor(tmp, { run: true })).checks.find((c) => c.message.includes("failed (exit 155"));
    expect(build?.details).toEqual([log[0], log[2]]);
  });

  it("warns on a Stop hook that runs an outdated command", async () => {
    const settings = path.join(tmp, ".claude/settings.json");
    fs.writeFileSync(settings, fs.readFileSync(settings, "utf8").replace(HOOK_COMMAND, "npx flagrm hook stop"));
    expect(
      (await problems()).some((p) => p.startsWith("warn") && p.includes("outdated command (run flagrm update)")),
    ).toBe(true);
  });

  it("warns on a dirty tree, an outdated skill, a missing hook and an abandoned baseline", async () => {
    stampSkill(path.join(tmp, ".claude/skills/flagrm-remove/SKILL.md"), "0.0.1");
    fs.writeFileSync(path.join(tmp, ".claude/settings.json"), "{}\n");
    fs.mkdirSync(path.join(tmp, ".flagrm", "Old"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".flagrm", "Old", "baseline.json"),
      JSON.stringify({ flag: "Old", git: { sha: "0123456789012345678901234567890123456789", dirty: false } }),
    );
    const found = await problems();
    expect(found.some((p) => p.startsWith("warn") && p.includes("uncommitted"))).toBe(true);
    expect(found.some((p) => p.startsWith("warn .claude/skills") && p.includes("run flagrm update"))).toBe(true);
    expect(found.some((p) => p.startsWith("warn") && p.includes("Stop hook"))).toBe(true);
    expect(found.some((p) => p.startsWith("warn .flagrm/Old") && p.includes("abandoned"))).toBe(true);
    expect((await runDoctor(tmp)).status).toBe("ok");
  });

  it("checks the skills and hook next to a config in a parent directory", async () => {
    fs.mkdirSync(path.join(tmp, "backend", "src"), { recursive: true });
    expect(await problems(path.join(tmp, "backend", "src"))).toEqual([]);
  });
});

describe("simpleCommandProgram", () => {
  it("is the first word of a simple command, after `VAR=value` words", () => {
    expect(simpleCommandProgram("dotnet build")).toBe("dotnet");
    expect(simpleCommandProgram("CI=1 npm test")).toBe("npm");
    expect(simpleCommandProgram(".\\node_modules\\.bin\\ng build")).toBe(".\\node_modules\\.bin\\ng");
  });

  it("leaves commands with shell syntax to the build and test runs", () => {
    for (const command of [
      "cd web && ./node_modules/.bin/ng build",
      "dotnet build 2>&1 | tee build.log",
      "f() { make; }; f",
      "cat <<EOF\nhello\nEOF",
      'echo "a\\"b" && make',
      "$BUILD",
    ]) {
      expect(simpleCommandProgram(command)).toBeUndefined();
    }
  });
});
