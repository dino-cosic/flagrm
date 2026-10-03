import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { words } from "../src/core/flag-words.js";
import type { RecordedName } from "../src/core/types.js";
import { classifyRemovedTests, type RemovedTestsContext } from "../src/core/verify/removed-tests.js";

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
