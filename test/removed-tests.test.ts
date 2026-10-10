import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { words } from "../src/core/flag-words.js";
import type { RecordedName } from "../src/core/types.js";
import {
  classifyRemovedTests,
  declaredTestDiff,
  declaredTests,
  type RemovedTestsContext,
} from "../src/core/verify/removed-tests.js";

let tmp: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-removed-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const NAMES: RecordedName[] = [
  { name: "pm-26500-vfo1-foundation", kind: "literal", source: "discovery" },
  { name: "FeatureFlagKeys.Vfo1Foundation", kind: "alias", source: "discovery" },
];
const ctx = (over: Partial<RemovedTestsContext> = {}): RemovedTestsContext => ({
  root: tmp,
  names: NAMES,
  testConfigChanged: false,
  ...over,
});

describe("words", () => {
  it("splits identifiers and titles into lowercase words, keeping digits on their word", () => {
    expect(words("Vfo1FoundationEnabled_ReturnsX")).toEqual(["vfo1", "foundation", "enabled", "returns", "x"]);
    expect(words("VFO1Foundation")).toEqual(["vfo1", "foundation"]);
    expect(words("places the order when NewCheckout is on")).toEqual([
      "places",
      "the",
      "order",
      "when",
      "new",
      "checkout",
      "is",
      "on",
    ]);
  });
});

describe("classifyRemovedTests", () => {
  it("matches a test renamed without the flag's words, in the same class", () => {
    const removed = [
      "Bit.Core.Test.PolicyTests.Vfo1FoundationEnabled_ReturnsSso(sut: 1a)",
      "Bit.Core.Test.PolicyTests.GetName_Vfo1Enabled",
      "Bit.Core.Test.CollectionTests.Plural_WithVfo1Names",
      "Bit.Core.Test.OtherTests.Plural_WithVfo1Names",
    ];
    const added = [
      "Bit.Core.Test.PolicyTests.ReturnsSso(sut: 2b)",
      "Bit.Core.Test.PolicyTests.GetName",
      "Bit.Core.Test.CollectionTests.Plural",
      "Bit.Core.Test.ElsewhereTests.Plural",
    ];
    const result = classifyRemovedTests(removed, added, added, ctx());
    expect(result.renamed).toEqual([
      { from: removed[0], to: added[0] },
      { from: removed[1], to: added[1] },
      { from: removed[2], to: added[2] },
    ]);
    expect(result.unexplained).toEqual([removed[3]]);
  });

  it("doesn't count dropping words that aren't the flag's as a rename", () => {
    const result = classifyRemovedTests(["Ns.T.Save_WhenCached_Works"], ["Ns.T.Save_Works"], [], ctx());
    expect(result).toMatchObject({ renamed: [], unexplained: ["Ns.T.Save_WhenCached_Works"] });
  });

  it("explains each new test once: of an ON/OFF pair, one is renamed", () => {
    const removed = ["Ns.T.Save_Vfo1On", "Ns.T.Save_Vfo1Off"];
    const result = classifyRemovedTests(removed, ["Ns.T.Save"], ["Ns.T.Save"], ctx());
    expect(result.renamed).toHaveLength(1);
    expect(result.unexplained).toHaveLength(1);
  });

  describe("with a git history", () => {
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), text);
    };
    let sha: string;

    beforeEach(() => {
      git("init", "-q");
      write(
        "test/Core.Test/PolicyTests.cs",
        "class PolicyTests {\n  [Fact] public void Saves() {}\n  [Fact] public void ShowsLegacyName() {}\n" +
          "  [Theory, InlineData(true), InlineData(false)] public void Quote(bool on) {}\n}\n",
      );
      write("test/Core.Test/UntouchedTests.cs", "class UntouchedTests {\n  [Fact] public void Runs() {}\n}\n");
      git("add", "-A");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
      sha = git("rev-parse", "HEAD");
      write(
        "test/Core.Test/PolicyTests.cs",
        "class PolicyTests {\n  [Fact] public void Saves() {}\n  [Theory, InlineData(true)] public void Quote(bool on) {}\n}\n",
      );
    });

    const changed = () => ["test/Core.Test/PolicyTests.cs"];

    it("counts a test gone from a changed test file, and a dropped data row, as deleted", () => {
      const removed = ["Ns.PolicyTests.ShowsLegacyName", "Ns.PolicyTests.Quote(on: False)"];
      const after = ["Ns.PolicyTests.Saves", "Ns.PolicyTests.Quote(on: True)"];
      const result = classifyRemovedTests(removed, [], after, ctx({ sha, changedFiles: changed() }));
      expect(result).toMatchObject({ deleted: removed, unexplained: [] });
    });

    it("doesn't count a data row as deleted when the changed file still has every row", () => {
      write(
        "test/Core.Test/PolicyTests.cs",
        "class PolicyTests {\n  [Fact] public void Saves() {}\n" +
          "  [Theory, InlineData(true), InlineData(false)] public void Quote(bool on) {}\n}\n",
      );
      const removed = ["Ns.PolicyTests.Quote(on: False)"];
      const after = ["Ns.PolicyTests.Saves", "Ns.PolicyTests.Quote(on: True)"];
      const result = classifyRemovedTests(removed, [], after, ctx({ sha, changedFiles: changed() }));
      expect(result).toMatchObject({ deleted: [], unexplained: removed });
    });

    it("counts a test in an untouched file as excluded when the test config changed, unexplained otherwise", () => {
      const removed = ["Ns.UntouchedTests.Runs"];
      const base = { sha, changedFiles: changed() };
      expect(classifyRemovedTests(removed, [], [], ctx(base)).unexplained).toEqual(removed);
      expect(classifyRemovedTests(removed, [], [], ctx({ ...base, testConfigChanged: true })).excludedByConfig).toEqual(
        removed,
      );
    });

    it("counts a deleted test file's tests as deleted", () => {
      fs.rmSync(path.join(tmp, "test/Core.Test/UntouchedTests.cs"));
      const files = [...changed(), "test/Core.Test/UntouchedTests.cs"];
      const result = classifyRemovedTests(["Ns.UntouchedTests.Runs"], [], [], ctx({ sha, changedFiles: files }));
      expect(result.deleted).toEqual(["Ns.UntouchedTests.Runs"]);
    });
  });
});

describe("declaredTests", () => {
  it("names JS tests by their enclosing describe titles", () => {
    const spec = [
      "describe('CheckoutComponent', () => {",
      "  it('places the order', () => { const o = { a: 1 }; });",
      "  describe.each([[1], [2]])('submit', () => {",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal template text under test
      "    test.skip(`retries ${'x'}`, () => {});",
      "  });",
      "  // it('commented out', () => {});",
      "  it(\"shows the title\", () => { expect(/x/.test('not a test')).toBe(true); });",
      "});",
      "it('top level', () => {});",
    ].join("\n");
    expect(declaredTests(spec, "a.spec.ts")).toEqual([
      "CheckoutComponent › places the order",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal template text under test
      "CheckoutComponent › submit › retries ${'x'}",
      "CheckoutComponent › shows the title",
      "top level",
    ]);
  });

  it("names C# test methods like TRX, Go and pytest functions by name", () => {
    const cs = [
      "namespace Shop.Tests;",
      "public class CheckoutTests {",
      "  [Fact]",
      "  public async Task PlacesOrder() {}",
      "  [Theory]",
      "  [InlineData(true)]",
      "  public void Quote(bool express) {}",
      "  private void Helper() {}",
      "}",
    ].join("\n");
    expect(declaredTests(cs, "CheckoutTests.cs")).toEqual([
      "Shop.Tests.CheckoutTests.PlacesOrder",
      "Shop.Tests.CheckoutTests.Quote",
    ]);
    expect(declaredTests("func TestCart(t *testing.T) {}\nfunc helper() {}", "cart_test.go")).toEqual(["TestCart"]);
    expect(declaredTests("def test_total():\n    pass\ndef helper():\n    pass", "test_cart.py")).toEqual([
      "test_total",
    ]);
    expect(declaredTests("it('x', () => {})", "README.md")).toEqual([]);
  });
});

describe("declaredTestDiff", () => {
  it("flags data rows and .each cases, which logs count one by one", () => {
    git("init", "-q");
    fs.writeFileSync(path.join(tmp, "CartTests.cs"), "[Theory]\n[InlineData(true)]\npublic void Quote(bool b) {}\n");
    fs.writeFileSync(path.join(tmp, "b.spec.ts"), "it.each([1, 2])('x %i', () => {});\n");
    fs.writeFileSync(path.join(tmp, "c.spec.ts"), "it('x', () => {});\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
    const sha = git("rev-parse", "HEAD");
    for (const f of ["CartTests.cs", "b.spec.ts", "c.spec.ts"]) fs.appendFileSync(path.join(tmp, f), "\n");
    expect(declaredTestDiff(ctx({ sha, changedFiles: ["CartTests.cs"] })).rows).toBe(true);
    expect(declaredTestDiff(ctx({ sha, changedFiles: ["b.spec.ts"] })).rows).toBe(true);
    expect(declaredTestDiff(ctx({ sha, changedFiles: ["c.spec.ts"] })).rows).toBe(false);
  });

  it("compares declarations at the baseline and now as multisets", () => {
    git("init", "-q");
    const file = path.join(tmp, "a.spec.ts");
    const block = (title: string) => `describe('Cart', () => { it('${title}', () => {}); });\n`;
    fs.writeFileSync(file, block("adds") + block("adds") + block("removes when NewCheckout is on"));
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
    const sha = git("rev-parse", "HEAD");
    fs.writeFileSync(file, block("adds") + block("removes"));
    expect(declaredTestDiff(ctx({ sha, changedFiles: ["a.spec.ts"] }))).toEqual({
      removed: ["Cart › adds", "Cart › removes when NewCheckout is on"],
      added: ["Cart › removes"],
      now: ["Cart › adds", "Cart › removes"],
      rows: false,
    });
  });

  it("counts a test file new since the baseline, so a moved spec cancels out", () => {
    git("init", "-q");
    const body = "describe('Cart', () => { it('adds', () => {}); it('removes', () => {}); });\n";
    fs.mkdirSync(path.join(tmp, "old"));
    fs.writeFileSync(path.join(tmp, "old", "a.spec.ts"), body);
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
    const sha = git("rev-parse", "HEAD");
    fs.rmSync(path.join(tmp, "old"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "new"));
    fs.writeFileSync(path.join(tmp, "new", "a.spec.ts"), body);
    const diff = declaredTestDiff(ctx({ sha, changedFiles: ["old/a.spec.ts", "new/a.spec.ts"] }));
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.now).toEqual(["Cart › adds", "Cart › removes"]);
  });
});
