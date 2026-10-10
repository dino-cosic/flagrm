import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { resolveProjects } from "../src/core/registry.js";
import type { Baseline, CheckResult, CheckRun } from "../src/core/types.js";
import { coverageCheck } from "../src/core/verify/coverage.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-coverage-")));
  for (const dir of ["web/e2e", "docs"]) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CONFIG = `projects:
  - name: web
    adapter: generic
    path: ./web
    methods: [isEnabled]
    covers: ["src/**"]
  - name: e2e
    adapter: generic
    path: ./web/e2e
    methods: [isEnabled]
  - name: docs
    adapter: generic
    path: ./docs
    methods: [isEnabled]
`;

/** The coverage check for these changed files, when the projects in `ran` ran a command. */
function coverage(changedFiles: string[] | undefined, ran: string[], config = CONFIG): CheckResult {
  fs.writeFileSync(path.join(tmp, "flagrm.config.yaml"), config);
  const runs = ran.map(
    (project): CheckRun => ({ project, check: "build", command: "true", exitCode: 0, durationMs: 0 }),
  );
  return coverageCheck({
    root: tmp,
    flag: "F",
    projects: resolveProjects(loadConfig({ quiet: true }, tmp)),
    baseline: {} as Baseline,
    changedFiles,
    runs,
    configChanges: [],
    originalConfigChanges: [],
  });
}
const warnings = (result: CheckResult) => result.findings.map((f) => `${f.project ?? "-"} ${f.message}`);

describe("coverage check", () => {
  it("is skipped without a baseline commit, and passes without changed files", () => {
    expect(coverage(undefined, ["web"])).toMatchObject({
      id: "coverage",
      status: "skipped",
      summary: "no baseline commit to diff against",
    });
    expect(coverage([], [])).toMatchObject({
      status: "pass",
      summary: "every changed file is built, tested or linted",
    });
  });

  it("passes for a file a project with a command covers", () => {
    expect(coverage(["web/src/app.ts"], ["web"]).status).toBe("pass");
  });

  it("warns about a file outside covers, outside every project, or in a project that ran nothing", () => {
    const result = coverage(["web/playwright/x.ts", "README.md", "docs/guide.md"], ["web"]);
    expect(result).toMatchObject({ status: "warn", summary: "3 changed files no command checks" });
    expect(warnings(result)).toEqual([
      "web web/playwright/x.ts: no build, test or lint command checks it",
      "- README.md: no build, test or lint command checks it",
      "docs docs/guide.md: no build, test or lint command checks it",
    ]);
  });

  it("reports the innermost project, and any covering project suffices", () => {
    expect(warnings(coverage(["web/e2e/login.spec.ts"], ["web"]))).toEqual([
      "e2e web/e2e/login.spec.ts: no build, test or lint command checks it",
    ]);
    expect(coverage(["web/e2e/login.spec.ts"], ["e2e"]).status).toBe("pass");
    expect(coverage(["web/e2e/login.spec.ts"], ["web"], CONFIG.replace('    covers: ["src/**"]\n', "")).status).toBe(
      "pass",
    );
  });

  it("matches covers written with ./ and dotfiles", () => {
    const config = CONFIG.replace('["src/**"]', '["./src/**"]');
    expect(coverage(["web/src/app.ts", "web/src/.eslintrc.json"], ["web"], config).status).toBe("pass");
  });

  it("counts deleted files, and every file when no command ran (--skip)", () => {
    // Nothing on disk: changed files come from git, deleted ones included.
    expect(warnings(coverage(["web/src/gone.ts"], []))).toEqual([
      "web web/src/gone.ts: no build, test or lint command checks it",
    ]);
  });

  it("groups more than 20 uncovered files by top-level directory", () => {
    const files = [
      ...Array.from({ length: 15 }, (_, i) => `scripts/s${i}.sh`),
      ...Array.from({ length: 6 }, (_, i) => `f${i}.md`),
    ];
    const result = coverage(files, []);
    expect(result.summary).toBe("21 changed files no command checks");
    expect(warnings(result)).toEqual([
      "- .: 6 changed files no build, test or lint command checks",
      "- scripts/: 15 changed files no build, test or lint command checks",
    ]);
  });

  it("covers everything in a project at the config root", () => {
    const config = "projects:\n  - name: app\n    adapter: generic\n    path: .\n    methods: [isEnabled]\n";
    expect(coverage(["README.md", "web/x.ts"], ["app"], config).status).toBe("pass");
  });
});
