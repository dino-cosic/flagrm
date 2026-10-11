import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectTestResults,
  diffTestNames,
  hasTestNames,
  parseJestJson,
  parseJUnit,
  parseTrx,
  shortTestName,
  splitFailures,
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

const JEST = JSON.stringify({
  testResults: [
    {
      name: "/repo/src/app/checkout.spec.ts",
      assertionResults: [
        { ancestorTitles: ["CheckoutComponent", "submit"], title: "places the order", status: "passed" },
        { ancestorTitles: ["CheckoutComponent"], title: "shows the title", status: "failed" },
        { ancestorTitles: ["CheckoutComponent"], title: "is pending", status: "pending" },
        { ancestorTitles: [], title: "top level", status: "todo" },
      ],
    },
  ],
});

describe("parseJestJson", () => {
  it("names tests by their describe titles and maps statuses", () => {
    expect(parseJestJson(JEST)).toEqual({
      total: 4,
      passed: 1,
      failed: 1,
      skipped: 2,
      names: [
        "CheckoutComponent › submit › places the order",
        "CheckoutComponent › shows the title",
        "CheckoutComponent › is pending",
        "checkout.spec.ts › top level",
      ],
      failedNames: ["CheckoutComponent › shows the title"],
      files: [],
    });
  });

  it("is undefined for text that isn't Jest JSON", () => {
    expect(parseJestJson("{ half")).toBeUndefined();
    expect(parseJestJson('{"other":1}')).toBeUndefined();
  });

  it("is undefined for a file with null entries or a non-array assertionResults", () => {
    expect(parseJestJson('{"testResults":[null]}')).toBeUndefined();
    expect(parseJestJson('{"testResults":[{"name":"a.spec.ts","assertionResults":"nope"}]}')).toBeUndefined();
  });
});

describe("hasTestNames", () => {
  it("is true for results from files only", () => {
    expect(hasTestNames(undefined)).toBe(false);
    expect(hasTestNames(parseJUnit(JUNIT))).toBe(true);
    expect(hasTestNames({ ...parseJUnit(JUNIT), source: "log" })).toBe(false);
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

  it("skips a truncated or unrelated XML file", () => {
    fs.writeFileSync(path.join(tmp, "half.xml"), JUNIT.slice(0, JUNIT.lastIndexOf("</testcase>")));
    fs.writeFileSync(path.join(tmp, "coverage.xml"), '<?xml version="1.0"?><coverage line-rate="1"></coverage>');
    fs.writeFileSync(path.join(tmp, "half.trx"), TRX.replace("</TestRun>", ""));
    expect(collectTestResults(path.join(tmp, "*.{xml,trx}"), Date.now() - 5000)).toBeUndefined();
  });

  it("returns undefined when no fresh result file exists", () => {
    expect(collectTestResults(path.join(tmp, "*.trx"), Date.now())).toBeUndefined();
  });

  it("merges sharded JUnit files and Jest JSON, skipping a file it can't parse", () => {
    const dir = path.join(tmp, "shards");
    fs.mkdirSync(dir);
    for (const i of [1, 2, 3]) {
      fs.writeFileSync(
        path.join(dir, `junit-${i}.xml`),
        `<testsuite><testcase classname="S${i}" name="t"/></testsuite>`,
      );
    }
    fs.writeFileSync(path.join(dir, "jest.json"), JEST);
    fs.writeFileSync(path.join(dir, "broken.json"), "{ half");
    const merged = collectTestResults(path.join(dir, "*"), Date.now() - 1000);
    expect(merged?.total).toBe(7);
    expect(merged?.names).toContain("S2 › t");
    expect(merged?.files.map((f) => path.basename(f)).sort()).toEqual([
      "jest.json",
      "junit-1.xml",
      "junit-2.xml",
      "junit-3.xml",
    ]);
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

describe("splitFailures", () => {
  it("matches TRX data rows without their arguments, since AutoData values change between runs", () => {
    const before = ["Ns.T.Saves(sut: Castle.Proxy, id: 7f3a)"];
    const now = ["Ns.T.Saves(sut: Castle.Proxy, id: 91bc)"];
    expect(splitFailures(before, now)).toEqual({ known: now, new: [] });
  });

  it("counts rows per test: a second failing row of the same theory is new", () => {
    const before = ["Ns.T.Quote(on: False)"];
    const now = ["Ns.T.Quote(on: False)", "Ns.T.Quote(on: True)"];
    expect(splitFailures(before, now)).toEqual({ known: [now[0]], new: [now[1]] });
  });

  it("keeps JUnit names whole", () => {
    expect(splitFailures(["A › shows (x)"], ["A › shows (y)"])).toEqual({ known: [], new: ["A › shows (y)"] });
  });
});
