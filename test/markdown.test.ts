import { describe, expect, it } from "vitest";
import { verifyMarkdown } from "../src/core/markdown.js";
import type { VerifyReport } from "../src/core/types.js";

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
    tests: [{ project: "api", before: 9, after: 7, removed: ["T.Off1", "T.Off2"], added: [] }],
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
        "**Tests that no longer run (2):** `T.Off1`, `T.Off2`",
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
          {
            project: "api",
            before: 3,
            after: 1,
            removed: [
              "Bit.Api.Test.JobTests.Run_WhenOff(sutProvider: SutProvider`1 { Fixture = [···] })",
              "Bit.Api.Test.JobTests.Quote(express: True)",
              "Bit.Api.Test.JobTests.Quote(express: False)",
            ],
            added: ["sorts devices › sorts devices"],
          },
        ],
      }),
      "/r",
    );
    expect(md).toContain("**Tests that no longer run (3):** `JobTests.Run_WhenOff(…)`, `JobTests.Quote(…) ×2`");
    expect(md).toContain("**New tests (1):** `sorts devices`");
  });

  it("caps long lists at 20 entries", () => {
    const changedFiles = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const md = verifyMarkdown(report({ changedFiles }), "/r");
    expect(md).toContain("`f19.ts` and 5 more");
    expect(md).not.toContain("`f20.ts`");
  });
});
