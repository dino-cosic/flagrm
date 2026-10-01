import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectTestResults,
  diffTestNames,
  parseJUnit,
  parseTrx,
  shortTestName,
} from "../src/core/verify/test-results.js";

const TRX = `<?xml version="1.0" encoding="utf-8"?>
<TestRun id="1" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Results>
    <UnitTestResult executionId="a" testName="Shop.Tests.CheckoutTests.PlacesOrder" outcome="Passed" />
    <UnitTestResult executionId="b" testName="Shop.Tests.CheckoutTests.Quote(express: True, expected: 15)" outcome="Passed" />
    <UnitTestResult executionId="c" outcome="Failed" testName="Shop.Tests.CheckoutTests.Quote(express: False, expected: 5)">
      <Output><ErrorInfo><Message>Assert.Equal() Failure &amp; more</Message></ErrorInfo></Output>
    </UnitTestResult>
    <UnitTestResult executionId="d" testName="Shop.Tests.CheckoutTests.Skipped" outcome="NotExecuted" />
  </Results>
  <ResultSummary outcome="Failed"><Counters total="4" executed="3" passed="2" failed="1" /></ResultSummary>
</TestRun>`;

const JUNIT = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="Chrome" tests="4">
    <testcase name="places the order when NewCheckout is on" classname="Chrome.CheckoutComponent" time="0.1"/>
    <testcase name="shows &quot;legacy&quot; title" classname="Chrome.CheckoutComponent">
      <failure message="Expected">stack</failure>
    </testcase>
    <testcase name="is pending" classname="Chrome.CheckoutComponent"><skipped/></testcase>
    <testcase name="errors" classname="Chrome.Header"><error message="boom"/></testcase>
  </testsuite>
</testsuites>`;

describe("parseTrx", () => {
  it("counts outcomes and keeps each data row's full test name", () => {
    const r = parseTrx(TRX);
    expect(r).toMatchObject({ total: 4, passed: 2, failed: 1, skipped: 1 });
    expect(r.names).toContain("Shop.Tests.CheckoutTests.Quote(express: False, expected: 5)");
    expect(r.failedNames).toEqual(["Shop.Tests.CheckoutTests.Quote(express: False, expected: 5)"]);
  });
});

describe("parseJUnit", () => {
  it("counts testcases by their failure/error/skipped children", () => {
    const r = parseJUnit(JUNIT);
    expect(r).toMatchObject({ total: 4, passed: 1, failed: 2, skipped: 1 });
    expect(r.names[0]).toBe("Chrome.CheckoutComponent › places the order when NewCheckout is on");
    expect(r.failedNames).toEqual(['Chrome.CheckoutComponent › shows "legacy" title', "Chrome.Header › errors"]);
  });
});

describe("collectTestResults", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-results-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("merges result files matching the glob that were written since the run started", () => {
    const stale = path.join(tmp, "old.trx");
    fs.writeFileSync(stale, TRX);
    fs.utimesSync(stale, new Date(2000, 1, 1), new Date(2000, 1, 1));
    fs.writeFileSync(path.join(tmp, "a.trx"), TRX);
    fs.writeFileSync(path.join(tmp, "b.xml"), JUNIT);
    const r = collectTestResults(path.join(tmp, "*.{trx,xml}"), Date.now() - 5000);
    expect(r?.total).toBe(8);
    expect(r?.files.map((f) => path.basename(f))).toEqual(["a.trx", "b.xml"]);
  });

  it("returns undefined when no fresh result file exists", () => {
    expect(collectTestResults(path.join(tmp, "*.trx"), Date.now())).toBeUndefined();
  });
});

describe("shortTestName", () => {
  it("drops a TRX name's namespace and data-row arguments", () => {
    expect(shortTestName("Shop.Tests.CheckoutTests.Quote(express: True, expected: 15)")).toBe("CheckoutTests.Quote(…)");
    expect(shortTestName("Shop.Tests.CheckoutTests.PlacesOrder")).toBe("CheckoutTests.PlacesOrder");
  });

  it("shows a JUnit name once when the class repeats the title", () => {
    expect(shortTestName("sortDevices sorts by date › sortDevices sorts by date")).toBe("sortDevices sorts by date");
    expect(shortTestName("CheckoutComponent › places the order")).toBe("CheckoutComponent › places the order");
  });
});

describe("diffTestNames", () => {
  const row = (args: string) => `Shop.Tests.CheckoutTests.Quote(${args})`;

  it("matches data rows whose generated argument values changed between runs", () => {
    const before = [row('sutProvider: SutProvider`1 { }, name: "a1b2"'), "Shop.Tests.CheckoutTests.PlacesOrder"];
    const after = [row('sutProvider: SutProvider`1 { }, name: "c3d4"'), "Shop.Tests.CheckoutTests.PlacesOrder"];
    expect(diffTestNames(before, after)).toEqual({ removed: [], added: [] });
  });

  it("reports a data row that no longer runs, preferring the one whose name is gone", () => {
    const before = [row("flagOn: True"), row("flagOn: False")];
    expect(diffTestNames(before, [row("flagOn: True")])).toEqual({ removed: [row("flagOn: False")], added: [] });
  });

  it("compares JUnit names exactly, even with parentheses in the title", () => {
    const before = ["Checkout › returns undefined (flag off)"];
    const after = ["Checkout › returns undefined (flag on)"];
    expect(diffTestNames(before, after)).toEqual({ removed: before, added: after });
  });
});
