import { describe, expect, it } from "vitest";
import { parseTestLog } from "../src/core/verify/log-results.js";

const result = (text: string) => {
  const r = parseTestLog(text);
  return r && { total: r.total, passed: r.passed, failed: r.failed, skipped: r.skipped, names: r.failedNames };
};

describe("parseTestLog", () => {
  it("reads Karma, keeping the last progress count of a \\r-updated line", () => {
    const log = [
      "Chrome Headless 120.0.0.0 (Mac OS 10.15.7) CheckoutComponent places the order FAILED",
      "\tError: Expected false to be true.",
      "Chrome Headless 120.0.0.0 (Mac OS 10.15.7): Executed 1 of 5 (1 FAILED)\rChrome Headless 120.0.0.0 (Mac OS 10.15.7): Executed 4 of 5 (1 FAILED) (skipped 1) (0.2 secs / 0.1 secs)",
      "TOTAL: 1 FAILED, 3 SUCCESS",
    ].join("\n");
    expect(result(log)).toEqual({
      total: 5,
      passed: 3,
      failed: 1,
      skipped: 1,
      names: ["CheckoutComponent places the order"],
    });
  });

  it("reads Jest, ignoring suites that failed to run and console blocks", () => {
    const log = [
      "  ● CheckoutComponent › submit › places the order",
      "  ● Test suite failed to run",
      "  ● Console",
      "Tests:       1 failed, 1 skipped, 3 passed, 5 total",
    ].join("\n");
    expect(result(log)).toEqual({
      total: 5,
      passed: 3,
      failed: 1,
      skipped: 1,
      names: ["CheckoutComponent › submit › places the order"],
    });
  });

  it("reads Vitest, once per test though FAIL and × both name it", () => {
    const log = [
      "   × CheckoutComponent > places the order 12ms",
      " FAIL  src/app/checkout.spec.ts > CheckoutComponent > places the order",
      " FAIL  |chromium| src/b.spec.ts > Other > breaks",
      "      Tests  2 failed | 3 passed | 1 skipped (6)",
    ].join("\n");
    expect(result(log)).toEqual({
      total: 6,
      passed: 3,
      failed: 2,
      skipped: 1,
      names: ["CheckoutComponent › places the order", "Other › breaks"],
    });
  });

  it("reads dotnet test, summing the summaries of several test projects", () => {
    const log = [
      "  Failed Shop.Tests.CheckoutTests.Quote(express: False, expected: 5) [12 ms]",
      "Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3, Duration: 1 s - Shop.Tests.dll (net8.0)",
      "Passed!  - Failed:     0, Passed:     4, Skipped:     1, Total:     5, Duration: 1 s - Other.Tests.dll (net8.0)",
    ].join("\n");
    expect(result(log)).toEqual({
      total: 8,
      passed: 6,
      failed: 1,
      skipped: 1,
      names: ["Shop.Tests.CheckoutTests.Quote(express: False, expected: 5)"],
    });
  });

  it("reads Go and pytest failures without counts", () => {
    expect(result("--- FAIL: TestCheckout (0.00s)\nFAILED tests/test_cart.py::test_total - AssertionError")).toEqual({
      total: 0,
      passed: 0,
      failed: 2,
      skipped: 0,
      names: ["TestCheckout", "tests/test_cart.py::test_total"],
    });
  });

  it("strips ANSI colors and marks the source", () => {
    const r = parseTestLog("\u001b[31m  ● A › b\u001b[39m\nTests:       1 failed, 1 total");
    expect(r?.failedNames).toEqual(["A › b"]);
    expect(r?.names).toEqual(["A › b"]);
    expect(r?.source).toBe("log");
    expect(r?.files).toEqual([]);
  });

  it("takes a test titled ...Warning for a failing test", () => {
    expect(parseTestLog("  ● Cart › shows low-stock Warning")?.failedNames).toEqual(["Cart › shows low-stock Warning"]);
  });

  it("is undefined for a log without test output", () => {
    expect(parseTestLog("error TS2304: Cannot find name 'x'.\nnpm ERR! Test failed.")).toBeUndefined();
  });

  it.each([
    "× Build failed in 12ms",
    "✗ Build failed in 1.2s",
    "Failed to load config [foo]",
    "Step 3 (docker) build FAILED",
    "● Validation Warning:",
    "● Deprecation Warning:",
  ])("does not take %j for a failing test", (line) => {
    expect(parseTestLog(line)).toBeUndefined();
  });
});
