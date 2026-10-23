import { describe, expect, it } from "vitest";
import { staleMarkdown, verifyMarkdown } from "../src/core/markdown.js";
import type { StaleReport, TestComparison, VerifyReport } from "../src/core/types.js";

function tests(c: Partial<TestComparison>): TestComparison {
  return {
    project: "api",
    removed: [],
    added: [],
    deleted: [],
    renamed: [],
    excludedByConfig: [],
    unexplained: [],
    newFailures: [],
    knownFailures: [],
    ...c,
  };
}

function report(overrides: Partial<VerifyReport> = {}): VerifyReport {
  return {
    schemaVersion: 6,
    flag: "NewCheckout",
    status: "pass",
    strict: false,
    createdAt: "2026-09-27T00:00:00.000Z",
    baseline: { file: "/r/.flagrm/NewCheckout/baseline.json", createdAt: "", git: { sha: "abc", dirty: false } },
    git: { sha: "abc", dirty: true },
    checks: [
      {
        id: "leftovers",
        status: "warn",
        summary: "1 comment naming the flag",
        findings: [{ severity: "warn", message: "comment mentions NewCheckout", file: "/r/src/a.ts", line: 3 }],
      },
      { id: "dead-code", status: "pass", summary: "no new unused code", findings: [] },
      { id: "build", status: "skipped", summary: "skipped (--skip)", findings: [] },
      { id: "tests", status: "pass", summary: "5 passed | 0 failed", findings: [] },
    ],
    skipped: ["build"],
    runs: [],
    tests: [tests({ before: 9, after: 7, removed: ["T.Off1", "T.Off2"], deleted: ["T.Off1", "T.Off2"] })],
    changedFiles: ["src/a.ts", "src/b.cs"],
    ...overrides,
  };
}

describe("verifyMarkdown", () => {
  it("renders status, checks, changed files, removed tests and warnings", () => {
    expect(verifyMarkdown(report(), "/r")).toBe(
      [
        "### flagrm verify: NewCheckout ✅ pass",
        "",
        "| Check | Status | Summary |",
        "|---|---|---|",
        "| leftovers | ⚠️ warn | 1 comment naming the flag |",
        "| dead-code | ✅ pass | no new unused code |",
        "| build | ➖ skipped | skipped (--skip) |",
        "| tests | ✅ pass | 5 passed \\| 0 failed |",
        "",
        "**Files changed since baseline (2):** `src/a.ts`, `src/b.cs`",
        "",
        "**Tests deleted (2):** `T.Off1`, `T.Off2`",
        "",
        "**Warnings:**",
        "- `src/a.ts:3` comment mentions NewCheckout",
        "",
      ].join("\n"),
    );
  });

  it("marks a failing verify and lists failures before warnings", () => {
    const md = verifyMarkdown(
      report({
        status: "fail",
        checks: [
          {
            id: "build",
            status: "fail",
            summary: "api build failed",
            findings: [{ severity: "fail", message: "exit 1" }],
          },
        ],
        tests: [],
        changedFiles: [],
      }),
      "/r",
    );
    expect(md.startsWith("### flagrm verify: NewCheckout ❌ fail\n")).toBe(true);
    expect(md).toContain("**Failures:**\n- exit 1");
    expect(md).not.toContain("Files changed");
    expect(md).not.toContain("Tests that no longer run");
  });

  it("shortens test names and lists new tests", () => {
    const md = verifyMarkdown(
      report({
        tests: [
          tests({
            before: 3,
            after: 1,
            unexplained: [
              "Bit.Api.Test.JobTests.Run_WhenOff(sutProvider: SutProvider`1 { Fixture = [···] })",
              "Bit.Api.Test.JobTests.Quote(express: True)",
              "Bit.Api.Test.JobTests.Quote(express: False)",
            ],
            added: ["sorts devices › sorts devices"],
          }),
        ],
      }),
      "/r",
    );
    expect(md).toContain(
      "**Tests that no longer run, unexplained (3):** `JobTests.Run_WhenOff(…)`, `JobTests.Quote(…) ×2`",
    );
    expect(md).toContain("**New tests (1):** `sorts devices`");
  });

  it("lists each reason a test no longer runs, and renamed tests once, not as new", () => {
    const md = verifyMarkdown(
      report({
        tests: [
          tests({
            deleted: ["Ns.T.Off"],
            renamed: [{ from: "Ns.T.Save_Vfo1Enabled", to: "Ns.T.Save" }],
            excludedByConfig: ["Ns.IntegrationT.Db"],
            added: ["Ns.T.Save", "Ns.T.New"],
          }),
        ],
      }),
      "/r",
    );
    expect(md).toContain("**Tests deleted (1):** `T.Off`");
    expect(md).toContain("**Tests excluded by a config change (1):** `IntegrationT.Db`");
    expect(md).toContain("**Tests renamed (1):** `T.Save_Vfo1Enabled` → `T.Save`");
    expect(md).toContain("**New tests (1):** `T.New`");
    expect(md).not.toContain("unexplained");
  });

  it("caps long lists at 20 entries", () => {
    const changedFiles = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const md = verifyMarkdown(report({ changedFiles }), "/r");
    expect(md).toContain("`f19.ts` and 5 more");
    expect(md).not.toContain("`f20.ts`");
  });

  it("notes runs reused from an earlier verify", () => {
    const reused = { flag: "NewCheckout", createdAt: "2026-09-26T23:58:00.000Z" };
    const md = verifyMarkdown(
      report({
        runs: [
          { project: "api", check: "build", command: "b", exitCode: 0, durationMs: 1, reused },
          { project: "api", check: "test", command: "t", exitCode: 0, durationMs: 1, reused },
        ],
      }),
      "/r",
    );
    expect(md).toContain(
      "_build and tests reused from NewCheckout's verify (same tree and commands, 2 min ago; --no-reuse to run them)_",
    );
  });
});

describe("staleMarkdown", () => {
  const report: StaleReport = {
    schemaVersion: 8,
    project: "shop",
    evaluatedAt: "2026-10-01T00:00:00.000Z",
    conditions: {
      environments: ["production", "staging"],
      minDaysOn: 30,
      temporaryOnly: true,
      tags: { include: [], exclude: ["permanent"] },
    },
    flags: [
      {
        key: "express-shipping",
        codeName: "ExpressShipping",
        verdict: "keep",
        reasons: ["production: targeted (1 rule(s))"],
        environments: [
          { environment: "production", serves: "targeted", detail: "1 rule(s)" },
          {
            environment: "staging",
            serves: "fixed",
            value: true,
            since: "2026-09-30T00:00:00.000Z",
            sinceSource: "lastModified",
            days: 1,
          },
        ],
      },
      {
        key: "new-checkout",
        codeName: "NewCheckout",
        verdict: "remove",
        reasons: [],
        environments: [
          {
            environment: "production",
            serves: "fixed",
            value: true,
            since: "2026-08-17T00:00:00.000Z",
            sinceSource: "audit",
            days: 45,
          },
        ],
      },
      { key: "old-banner", verdict: "unreferenced", reasons: [], environments: [] },
    ],
  };

  it("groups flags by verdict with their environments and reasons", () => {
    expect(staleMarkdown(report)).toBe(
      [
        "### flagrm stale: shop — 1 ready to remove",
        "",
        "_Conditions: boolean, true in production, staging for 30+ days; temporary; not tagged permanent. Evaluated 2026-10-01T00:00:00.000Z._",
        "",
        "**Ready to remove (1)**",
        "",
        "| Flag | Code name | Environments |",
        "|---|---|---|",
        "| `new-checkout` | `NewCheckout` | production true 45d |",
        "",
        "**Keep (1)**",
        "",
        "| Flag | Code name | Environments | Reasons |",
        "|---|---|---|---|",
        "| `express-shipping` | `ExpressShipping` | production targeted (1 rule(s)), staging true 1d* | production: targeted (1 rule(s)) |",
        "",
        "**Not referenced in this repository (1):** `old-banner`",
        "",
        "_Another repository may still read these; flagrm doesn't recommend archiving them._",
        "",
        "_\\* days since the environment last changed: the audit log had no targeting change to date._",
      ].join("\n"),
    );
  });
});
