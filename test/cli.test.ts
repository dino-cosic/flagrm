import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, "..", "examples", "sample-app");
const CLI = path.resolve(HERE, "..", "dist", "cli.js");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, input?: string): CliResult {
  // picocolors colors output whenever `CI` is set (GitHub Actions), even without a TTY.
  const env = { ...process.env, NO_COLOR: "1" };
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env, input });
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffr-cli-"));
  fs.cpSync(SAMPLE, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), "frontend: ./frontend\nbackend: ./backend\n", "utf8");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("CLI end-to-end (spawned dist/cli.js)", () => {
  it("list --json inventories the flags and exits 0", () => {
    const { status, stdout } = runCli(["list", "--json"], tmp);
    expect(status).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.schemaVersion).toBe(7);
    expect(Array.isArray(report.candidates)).toBe(true);
    const entry = report.flags.find((f: { flag: string }) => f.flag === "EnableNewDashboard");
    expect(entry).toBeDefined();
    expect(entry.config.length).toBeGreaterThan(0);
    expect(entry.references.total).toBeGreaterThan(0);
  });

  it("list prints one entry per flag with its definitions and config", () => {
    const { status, stdout } = runCli(["list"], tmp);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^EnableNewDashboard\s+boolean/m);
    expect(stdout).toMatch(/^\s+config\s+backend\s+default\s+on\s+backend[\\/]appsettings\.json:\d+/m);
  });

  it("offers only the agent-first commands", () => {
    const { stdout } = runCli(["--help"], tmp);
    for (const command of ["list", "baseline", "verify", "init", "hook", "update", "doctor"])
      expect(stdout).toContain(command);
    for (const removed of ["fold", "inspect", "scan", "report"]) {
      expect(runCli([removed, "EnableNewDashboard"], tmp).status).not.toBe(0);
    }
  });
});

describe("CLI with a projects: config (spawned dist/cli.js)", () => {
  let projTmp: string;

  beforeAll(() => {
    projTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffr-projects-"));
    fs.cpSync(SAMPLE, projTmp, { recursive: true });
    fs.writeFileSync(
      path.join(projTmp, "flagrm.config.yaml"),
      [
        "projects:",
        "  - { name: api, adapter: dotnet, path: ./backend }",
        "  - { name: web, adapter: angular, path: ./frontend }",
        "",
      ].join("\n"),
      "utf8",
    );
  });

  afterAll(() => {
    fs.rmSync(projTmp, { recursive: true, force: true });
  });

  it("counts references per configured project name", () => {
    const { status, stdout } = runCli(["list", "--json"], projTmp);
    expect(status).toBe(0);
    const entry = JSON.parse(stdout).flags.find((f: { flag: string }) => f.flag === "EnableNewDashboard");
    expect(entry.projects).toEqual(["api", "web"]);
  });
});

describe("CLI baseline and verify (spawned dist/cli.js)", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ffr-verify-")));
    fs.cpSync(path.resolve(HERE, "fixtures", "realistic", "before"), dir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("baseline --no-checks writes the baseline and prints it as JSON", () => {
    const { status, stdout } = runCli(["baseline", "NewCheckout", "--no-checks", "--json"], dir);
    expect(status).toBe(0);
    const baseline = JSON.parse(stdout);
    expect(baseline).toMatchObject({ schemaVersion: 7, flag: "NewCheckout", git: { sha: null, dirty: false } });
    expect(baseline.checks).toBeUndefined();
    const file = path.join(dir, ".flagrm", "NewCheckout", "baseline.json");
    expect(baseline.baselineFile).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).flag).toBe("NewCheckout");
  });

  it("baseline prints a human summary by default", () => {
    const { status, stdout } = runCli(["baseline", "NewCheckout", "--no-checks", "--force"], dir);
    expect(status).toBe(0);
    expect(stdout).toContain("Baseline for NewCheckout written to .flagrm/NewCheckout/baseline.json");
  });

  it("baseline --name adds names to the existing baseline without rerunning it", () => {
    const { status, stdout } = runCli(
      ["baseline", "NewCheckout", "--name", "UseNewCheckout", "--kind", "wrapper", "--json"],
      dir,
    );
    expect(status).toBe(0);
    const baseline = JSON.parse(stdout);
    expect(baseline.names[0]).toEqual({ name: "NewCheckout", kind: "literal", source: "discovery" });
    expect(baseline.names).toContainEqual({ name: "UseNewCheckout", kind: "wrapper", source: "agent" });
  });

  it("baseline --name --file records a name for one file", () => {
    const file = path.join("backend", "src", "Shop.Api", "Services", "CheckoutService.cs");
    const { status, stdout } = runCli(
      ["baseline", "NewCheckout", "--name", "useNew", "--kind", "wrapper", "--file", file, "--json"],
      dir,
    );
    expect(status).toBe(0);
    expect(JSON.parse(stdout).names).toContainEqual({
      name: "useNew",
      kind: "wrapper",
      source: "agent",
      file: "backend/src/Shop.Api/Services/CheckoutService.cs",
    });
    expect(runCli(["baseline", "NewCheckout", "--file", file], dir).status).toBe(2);
  });

  it("baseline refuses to overwrite an existing baseline without --force", () => {
    const { status, stderr } = runCli(["baseline", "NewCheckout", "--no-checks"], dir);
    expect(status).toBe(2);
    expect(stderr).toContain("already exists; pass --name to add names, or --force to start over");
  });

  it("baseline --force refuses to start over once the code is edited", () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ffr-force-")));
    try {
      fs.cpSync(path.resolve(HERE, "fixtures", "realistic", "before"), repo, { recursive: true });
      const git = (...args: string[]) => spawnSync("git", args, { cwd: repo });
      git("init", "-q");
      git("add", "-A");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
      expect(runCli(["baseline", "NewCheckout", "--no-checks"], repo).status).toBe(0);
      expect(runCli(["baseline", "NewCheckout", "--no-checks", "--force"], repo).status).toBe(0);
      const file = path.join(repo, ".flagrm", "NewCheckout", "baseline.json");
      const before = fs.readFileSync(file, "utf8");
      fs.appendFileSync(path.join(repo, "frontend", "src", "main.ts"), "\n// edited\n");
      const { status, stderr } = runCli(["baseline", "NewCheckout", "--no-checks", "--force"], repo);
      expect(status).toBe(2);
      expect(stderr).toContain("frontend/src/main.ts");
      expect(stderr).toContain("git stash -u");
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("baseline rejects a flag evaluation method as a name, and an unknown kind", () => {
    const method = runCli(["baseline", "NewCheckout", "--name", "isEnabled"], dir);
    expect(method.status).toBe(2);
    expect(method.stderr).toContain("flag evaluation method");
    const kind = runCli(["baseline", "NewCheckout", "--name", "X", "--kind", "literal"], dir);
    expect(kind.status).toBe(2);
    expect(kind.stderr).toContain("--kind must be alias or wrapper");
  });

  it("verify --json exits 1 while recorded names remain and writes verify.json", () => {
    const { status, stdout } = runCli(["verify", "NewCheckout", "--skip", "build,tests", "--json"], dir);
    expect(status).toBe(1);
    const report = JSON.parse(stdout);
    const byId = Object.fromEntries(report.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
    expect(byId).toEqual({ leftovers: "fail", "dead-code": "skipped", build: "skipped", tests: "skipped" });
    expect(report.verifyFile).toBe(path.join(dir, ".flagrm", "NewCheckout", "verify.json"));
  });

  it("verify prints each check", () => {
    const { status, stdout } = runCli(["verify", "NewCheckout", "--skip", "leftovers,build,tests"], dir);
    expect(status).toBe(0);
    expect(stdout).toContain("flagrm verify NewCheckout — PASS");
  });

  it("verify --md prints the markdown overview", () => {
    const { status, stdout } = runCli(["verify", "NewCheckout", "--skip", "leftovers,build,tests", "--md"], dir);
    expect(status).toBe(0);
    expect(stdout.startsWith("### flagrm verify: NewCheckout ✅ pass\n")).toBe(true);
    expect(stdout).toContain("| leftovers | ➖ skipped |");
  });

  it("verify rejects --md with --json", () => {
    const { status, stderr } = runCli(["verify", "NewCheckout", "--md", "--json"], dir);
    expect(status).toBe(2);
    expect(stderr).toContain("--md and --json can't be combined");
  });

  it("exits 2 on usage errors: no baseline, unknown check", () => {
    const missing = runCli(["verify", "Nope", "--skip", "build,tests"], dir);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("flagrm baseline Nope");
    const unknown = runCli(["verify", "NewCheckout", "--skip", "lint"], dir);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('Unknown check "lint"');
  });
});

describe("CLI scope (spawned dist/cli.js)", () => {
  it("reports a .NET project this machine can build and test, and exits 0", () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ffr-scope-")));
    try {
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src", "Api.csproj"), '<Project Sdk="Microsoft.NET.Sdk" />\n');
      fs.writeFileSync(
        path.join(dir, "App.sln"),
        'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Api", "src\\Api.csproj", "{1}"\nEndProject\n',
      );
      fs.writeFileSync(
        path.join(dir, "flagrm.config.yaml"),
        "projects:\n  - name: api\n    adapter: dotnet\n    path: .\n",
      );
      const { status, stdout } = runCli(["scope", "--json"], dir);
      expect(status).toBe(0);
      expect(JSON.parse(stdout).projects).toEqual([
        {
          project: "api",
          setup: expect.objectContaining({ problems: [], leaveOut: [], solution: path.join(dir, "App.sln") }),
        },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CLI init (spawned dist/cli.js)", () => {
  let initTmp: string;

  beforeAll(() => {
    initTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ffr-init-"));
  });

  afterAll(() => {
    fs.rmSync(initTmp, { recursive: true, force: true });
  });

  it("sets up config, skills for Claude Code, Copilot and Codex, AGENTS.md, the Stop hook and .gitignore", () => {
    const { status, stdout } = runCli(["init"], initTmp);
    expect(status).toBe(0);
    expect(fs.existsSync(path.join(initTmp, "flagrm.config.yaml"))).toBe(true);
    for (const agent of [".github", ".claude", ".agents"]) {
      for (const skill of ["flagrm-remove", "flagrm-verify"]) {
        expect(fs.existsSync(path.join(initTmp, agent, "skills", skill, "SKILL.md"))).toBe(true);
      }
    }
    expect(fs.existsSync(path.join(initTmp, ".cursor"))).toBe(false);
    expect(fs.existsSync(path.join(initTmp, ".claude", "skills", "flagrm-remove", "patterns.md"))).toBe(true);
    expect(fs.readFileSync(path.join(initTmp, ".claude", "settings.json"), "utf8")).toContain(
      "npx --no-install flagrm hook stop",
    );
    expect(fs.readFileSync(path.join(initTmp, "AGENTS.md"), "utf8")).toContain("<!-- flagrm:start -->");
    expect(stdout).toMatch(/created\s+flagrm\.config\.yaml/);
    expect(stdout).toContain("/flagrm-remove <FlagName>");
    expect(stdout).toContain("flagrm doctor");
  });

  it("skips already-installed targets on a second run instead of overwriting", () => {
    fs.writeFileSync(path.join(initTmp, ".agents", "skills", "flagrm-remove", "MARKER.txt"), "keep-me", "utf8");
    const { status, stdout } = runCli(["init"], initTmp);
    expect(status).toBe(0);
    expect(stdout).toMatch(/skipped\s+flagrm\.config\.yaml/);
    expect(stdout).toMatch(/skipped\s+\.agents\/skills\/flagrm-remove/);
    expect(fs.existsSync(path.join(initTmp, ".agents", "skills", "flagrm-remove", "MARKER.txt"))).toBe(true);
  });
});

describe("CLI hook stop (spawned dist/cli.js)", () => {
  let hookDir: string;

  beforeAll(() => {
    hookDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ffr-hook-")));
  });

  afterAll(() => {
    fs.rmSync(hookDir, { recursive: true, force: true });
  });

  it("prints nothing and exits 0 when there is nothing to check, or on bad input", () => {
    for (const input of ["{}", "not json", "", "null", "5", "[]"]) {
      const { status, stdout } = runCli(["hook", "stop"], hookDir, input);
      expect(status).toBe(0);
      expect(stdout).toBe("");
    }
  });

  it("blocks an unverified removal when run from a subdirectory of the config root", () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ffr-hook-repo-")));
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    try {
      git("init", "-q");
      fs.writeFileSync(path.join(repo, ".gitignore"), ".flagrm/\n");
      fs.writeFileSync(
        path.join(repo, "flagrm.config.yaml"),
        "projects:\n  - name: svc\n    adapter: generic\n    path: .\n    globs: ['**/*.txt']\n",
      );
      fs.mkdirSync(path.join(repo, "src"));
      fs.writeFileSync(path.join(repo, "src", "a.txt"), "a\n");
      git("add", "-A");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
      expect(runCli(["baseline", "NewCheckout", "--no-checks"], repo).status).toBe(0);
      fs.writeFileSync(path.join(repo, "src", "a.txt"), "edited\n");
      const sub = path.join(repo, "src");
      const { status, stdout } = runCli(["hook", "stop"], sub, JSON.stringify({ cwd: sub }));
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toMatchObject({ decision: "block" });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
