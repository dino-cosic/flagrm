import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addNames, discoverNames, runChecks, UsageError, writeBaseline } from "../src/core/baseline.js";
import { loadConfig, type ToolConfig } from "../src/core/config.js";
import { gitState, treeFingerprint } from "../src/core/git.js";
import { resolveProjects } from "../src/core/registry.js";
import type { CheckId, VerifyReport } from "../src/core/types.js";
import { verifyFlag } from "../src/core/verify/index.js";

// `verify` against test/fixtures/realistic: a baseline of before/, then the
// golden after/ or a known mistake applied on top, in a scratch git repo.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "fixtures", "realistic");
const FLAG = "NewCheckout";
const NO_COMMANDS: CheckId[] = ["build", "tests"];

let tmp: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-verify-")));
  fs.cpSync(path.join(FIXTURE, "before"), tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, ".gitignore"), ".flagrm/\nbin/\nobj/\njunit.xml\nresults.src.xml\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function workspace(adjust?: (config: ToolConfig) => void) {
  const config = loadConfig({}, tmp);
  adjust?.(config);
  return resolveProjects(config);
}

async function takeBaseline(adjust?: (config: ToolConfig) => void, withChecks = false): Promise<void> {
  const projects = workspace(adjust);
  const state = gitState(tmp);
  const checks = withChecks ? await runChecks(projects, path.join(tmp, ".flagrm", FLAG)) : undefined;
  writeBaseline(tmp, FLAG, projects, state, checks, await discoverNames(projects, FLAG));
}

/** Make the working tree match after/ (tracked files only; .git, .flagrm and ignored files stay). */
function applyAfter(): void {
  const after = path.join(FIXTURE, "after");
  for (const rel of git("ls-files").split("\n").filter(Boolean)) {
    if (rel !== ".gitignore" && !fs.existsSync(path.join(after, rel))) fs.rmSync(path.join(tmp, rel));
  }
  fs.cpSync(after, tmp, { recursive: true });
}

async function verify(options: { skip?: CheckId[]; strict?: boolean } = {}, adjust?: (c: ToolConfig) => void) {
  return (await verifyFlag(tmp, workspace(adjust), FLAG, { skip: NO_COMMANDS, ...options })).report;
}

const status = (report: VerifyReport) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
const findings = (report: VerifyReport, id: CheckId) =>
  report.checks
    .find((c) => c.id === id)
    ?.findings.filter((f) => f.severity !== "info")
    .map(
      (f) =>
        `${f.severity} ${f.file ? `${path.relative(tmp, f.file).split(path.sep).join("/")}:${f.line ?? ""} ` : ""}${f.message}`,
    ) ?? [];

describe("verify on the realistic fixture", () => {
  it("refuses to run without a baseline", async () => {
    await expect(verifyFlag(tmp, workspace(), FLAG)).rejects.toBeInstanceOf(UsageError);
  });

  it("passes on the golden after/ copy", async () => {
    await takeBaseline();
    applyAfter();
    const report = await verify();
    expect(findings(report, "dead-code")).toEqual([]);
    // Without the build, the changed C# files have no compiler output to read: not a dead-code pass.
    expect(status(report)).toEqual({ leftovers: "pass", "dead-code": "skipped", build: "skipped", tests: "skipped" });
    expect(report.checks.find((c) => c.id === "dead-code")?.summary).toBe(
      "compiler diagnostics skipped for api: no build output",
    );
    expect(report.status).toBe("pass");
    expect(report.skipped).toEqual(["build", "tests"]);
    expect(fs.existsSync(path.join(tmp, ".flagrm", FLAG, "verify.json"))).toBe(true);
    expect(report.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(report.fingerprint).toBe(treeFingerprint(tmp));
    expect(report.changedFiles?.length).toBeGreaterThan(0);
  });

  it("fails on unused code the removal left in a changed TypeScript file", async () => {
    await takeBaseline();
    applyAfter();
    const file = path.join(tmp, "frontend/src/app/checkout/checkout.component.ts");
    const leftover = "import { LegacyCartService } from './legacy-cart/legacy-cart.service';\n";
    fs.writeFileSync(file, leftover + fs.readFileSync(file, "utf8"));
    const report = await verify();
    expect(findings(report, "dead-code")).toEqual([
      "fail frontend/src/app/checkout/checkout.component.ts:1 TS6133 'LegacyCartService' is declared but its value is never read.",
    ]);
    expect(report.status).toBe("fail");
  });

  it("fails when the build breaks", async () => {
    const failingBuild = (config: ToolConfig) => {
      for (const p of config.projects) {
        p.build = `node -e "console.error('error TS2304: Cannot find name'); process.exit(2)"`;
        p.test = undefined;
      }
    };
    await takeBaseline();
    applyAfter();
    const report = await verify({ skip: [] }, failingBuild);
    expect(status(report)).toMatchObject({ build: "fail", tests: "skipped" });
    const build = report.checks.find((c) => c.id === "build")!;
    expect(build.findings.map((f) => f.message)).toContain("error TS2304: Cannot find name");
    expect(report.status).toBe("fail");
  });

  it("warns when a template changed but the Angular build only runs tsc", async () => {
    const tscOnly = (config: ToolConfig) => {
      for (const p of config.projects) {
        p.build = p.adapter === "angular" ? `node -e "" tsc` : `node -e ""`;
        p.test = undefined;
      }
    };
    await takeBaseline(tscOnly);
    applyAfter();
    const report = await verify({ skip: ["tests"] }, tscOnly);
    expect(status(report).build).toBe("warn");
    expect(findings(report, "build")).toEqual([expect.stringContaining("doesn't type-check Angular templates")]);
  });

  describe("test counts", () => {
    // The removal also changes feature-flag.service.spec.ts: one of its tests runs too.
    const SERVICE = `<testcase classname="FeatureFlagService" name="reads flags from the environment"/>`;
    const testcase = (name: string, body = "") =>
      `<testcase classname="CheckoutComponent" name="${name}">${body}</testcase>`;
    const junit = (...cases: string[]) =>
      `<testsuite>${cases.map((c) => (c.startsWith("<") ? c : testcase(c))).join("")}${SERVICE}</testsuite>`;
    const full = (name: string) => `CheckoutComponent › ${name}`;
    const ON = "places the order through the checkout API when NewCheckout is on";
    const OFF = "falls back to the legacy cart when NewCheckout is off";
    const OTHER = "shows the express shipping option";
    const withTests = (config: ToolConfig) => {
      for (const p of config.projects) {
        // A project with neither command falls back to the adapter's (dotnet build/test): give api a no-op build.
        p.build = p.name === "api" ? `node -e ""` : undefined;
        p.test = p.name === "web" ? `node -e "require('fs').copyFileSync('results.src.xml', 'junit.xml')"` : undefined;
        p.testResults = p.name === "web" ? path.join(tmp, "frontend", "junit.xml") : undefined;
      }
    };
    const results = (xml: string) => fs.writeFileSync(path.join(tmp, "frontend", "results.src.xml"), xml);

    it("passes when every baseline test still runs", async () => {
      results(junit(ON, OFF, OTHER));
      await takeBaseline(withTests, true);
      applyAfter();
      const report = await verify({ skip: ["build"] }, withTests);
      expect(status(report).tests).toBe("pass");
      expect(report.tests).toEqual([{ project: "web", before: 4, after: 4, removed: [], added: [] }]);
      expect(report.runs.find((r) => r.check === "test")?.results).not.toHaveProperty("names");
    });

    it("warns once about the tests that no longer run, and fails with --strict", async () => {
      results(junit(ON, OFF, OTHER));
      await takeBaseline(withTests, true);
      applyAfter();
      results(junit("places the order through the checkout API", OTHER));
      const report = await verify({ skip: ["build"] }, withTests);
      expect(report.tests[0]).toMatchObject({
        removed: [full(ON), full(OFF)],
        added: [full("places the order through the checkout API")],
      });
      expect(findings(report, "tests")).toEqual([expect.stringContaining("warn 2 tests no longer run")]);
      expect(report.status).toBe("pass");
      expect((await verify({ skip: ["build"], strict: true }, withTests)).status).toBe("fail");
    });

    describe("failing tests", () => {
      // Like withTests, but the command exits 1 when the results it copies contain a failure.
      const failing = (config: ToolConfig) => {
        withTests(config);
        const web = config.projects.find((p) => p.name === "web");
        if (web)
          web.test = `node -e "const fs=require('fs');fs.copyFileSync('results.src.xml','junit.xml');process.exit(/<failure/.test(fs.readFileSync('junit.xml','utf8'))?1:0)"`;
      };
      const fail = (name: string) => testcase(name, `<failure message="boom"/>`);
      const KNOWN = "formats prices in the user's locale";

      it("passes with a warning when every failure already failed at the baseline", async () => {
        results(junit(fail(KNOWN), ON, OFF, OTHER));
        await takeBaseline(failing, true);
        applyAfter();
        const report = await verify({ skip: ["build"] }, failing);
        const tests = report.checks.find((c) => c.id === "tests");
        expect(tests?.status).toBe("warn");
        expect(tests?.summary).toContain("apart from 1 known failure");
        expect(findings(report, "tests")).toEqual([expect.stringContaining("1 test fails, as at the baseline")]);
        expect(tests?.findings.map((f) => f.message)).toContain(`known failure: CheckoutComponent › ${KNOWN}`);
        expect(report.status).toBe("pass");
      });

      it("fails on a test that passed at the baseline, listing only the new failures", async () => {
        results(junit(fail(KNOWN), ON, OFF, OTHER));
        await takeBaseline(failing, true);
        applyAfter();
        results(junit(fail(KNOWN), fail(OTHER), ON, OFF));
        const report = await verify({ skip: ["build"] }, failing);
        const tests = report.checks.find((c) => c.id === "tests");
        expect(tests?.status).toBe("fail");
        expect(findings(report, "tests")).toEqual([
          expect.stringContaining("1 test fails that passed or didn't run at the baseline"),
        ]);
        const info = tests?.findings.filter((f) => f.severity === "info").map((f) => f.message);
        expect(info).toEqual([`new failure: CheckoutComponent › ${OTHER}`, "plus 1 known failure from the baseline"]);
      });
    });

    it("fingerprints the tree after the commands, including a report they write outside .gitignore", async () => {
      const unignoredReport = (config: ToolConfig) => {
        withTests(config);
        for (const p of config.projects) {
          if (p.name === "web") p.test = `node -e "require('fs').writeFileSync('report.txt', String(Date.now()))"`;
        }
      };
      await takeBaseline(unignoredReport);
      applyAfter();
      const report = await verify({ skip: ["build"] }, unignoredReport);
      expect(fs.existsSync(path.join(tmp, "frontend", "report.txt"))).toBe(true);
      expect(report.fingerprint).toBe(treeFingerprint(tmp));
    });

    it("warns about a changed test file none of whose tests ran", async () => {
      results(junit(ON, OFF, OTHER));
      await takeBaseline(withTests, true);
      applyAfter();
      results(`<testsuite><testcase classname="CheckoutComponent" name="${OTHER}"/></testsuite>`);
      const report = await verify({ skip: ["build"] }, withTests);
      expect(findings(report, "tests")).toEqual([
        expect.stringContaining("warn 3 tests no longer run"),
        expect.stringContaining(
          "warn frontend/src/app/core/feature-flag.service.spec.ts: changed, but none of its tests ran",
        ),
      ]);
    });
  });
});

describe("leftovers check", () => {
  const leftovers = (report: VerifyReport) => report.checks.find((c) => c.id === "leftovers");

  it("fails on the untouched code: every recorded name is still there", async () => {
    await takeBaseline();
    const report = await verify();
    expect(leftovers(report)?.status).toBe("fail");
    expect(findings(report, "leftovers").some((f) => /still references FeatureFlags\.NewCheckout/.test(f))).toBe(true);
    expect(report.status).toBe("fail");
  });

  it("fails on a leftover call of a wrapper the agent recorded", async () => {
    await takeBaseline();
    addNames(tmp, FLAG, [{ name: "IsNewCheckoutEnabledAsync", kind: "wrapper", source: "agent" }]);
    applyAfter();
    const leftover = path.join(tmp, "backend", "src", "Shop.Api", "Services", "Leftover.cs");
    fs.writeFileSync(
      leftover,
      "namespace Shop.Api.Services;\npublic static class Leftover { public static object Check(dynamic f) => f.IsNewCheckoutEnabledAsync(); }\n",
    );
    const report = await verify();
    expect(findings(report, "leftovers")).toEqual([
      expect.stringMatching(
        /^fail backend\/src\/Shop\.Api\/Services\/Leftover\.cs:2 still references IsNewCheckoutEnabledAsync/,
      ),
    ]);
  });

  it("fails on a config key left in appsettings.json", async () => {
    await takeBaseline();
    applyAfter();
    const file = path.join(tmp, "backend", "src", "Shop.Api", "appsettings.json");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace('"ExpressShipping": false', '"ExpressShipping": false,\n    "NewCheckout": true'),
    );
    const report = await verify();
    expect(leftovers(report)?.status).toBe("fail");
    expect(findings(report, "leftovers").some((f) => f.includes("appsettings.json"))).toBe(true);
  });

  it("fails on a section-qualified read left in code", async () => {
    await takeBaseline();
    applyAfter();
    fs.writeFileSync(
      path.join(tmp, "backend", "src", "Shop.Api", "Services", "Leftover.cs"),
      'namespace Shop.Api.Services;\npublic static class Leftover { public static object Check(dynamic c) => c.GetValue<bool>("FeatureManagement:NewCheckout"); }\n' +
        'public static class Lower { public static object Check(dynamic c) => c.GetValue<bool>("featureManagement:NewCheckout"); }\n',
    );
    const report = await verify();
    expect(findings(report, "leftovers")).toEqual([
      expect.stringMatching(/Leftover\.cs:2 still references FeatureManagement:NewCheckout/),
      expect.stringMatching(/Leftover\.cs:3 still references featureManagement:NewCheckout/),
    ]);
  });

  it("fails on the flag left in compose config: an environment variable or a quoted key", async () => {
    const withYaml = (config: ToolConfig) => config.include.push("**/*.yml");
    await takeBaseline(withYaml);
    applyAfter();
    fs.writeFileSync(
      path.join(tmp, "backend", "docker-compose.yml"),
      'services:\n  api:\n    environment:\n      - FeatureManagement__NewCheckout=true\n    labels:\n      "NewCheckout": on\n    url: http://NewCheckout:8080\n',
    );
    const report = await verify({}, withYaml);
    expect(findings(report, "leftovers")).toEqual([
      "fail backend/docker-compose.yml:6 still references NewCheckout",
      "fail backend/docker-compose.yml:4 still references FeatureManagement__NewCheckout",
    ]);
  });

  it("warns on a comment that still names the flag", async () => {
    await takeBaseline();
    applyAfter();
    fs.writeFileSync(
      path.join(tmp, "frontend", "src", "app", "note.ts"),
      "// NewCheckout is gone\nexport const note = 1;\n",
    );
    const report = await verify();
    expect(leftovers(report)?.status).toBe("warn");
    expect(findings(report, "leftovers")).toEqual([
      expect.stringMatching(/^warn frontend\/src\/app\/note\.ts:1 comment mentions NewCheckout/),
    ]);
  });
});
