import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { assertOwnNames, nameReads } from "../src/core/name-owner.js";
import { resolveProjects } from "../src/core/registry.js";

let tmp: string;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};
const workspace = () => resolveProjects(loadConfig({ quiet: true }, tmp));
const FLAGS = [
  { flag: "Paging", aliases: ["FeatureFlags.Paging"] },
  { flag: "PagingV2", aliases: ["FeatureFlags.PagingV2"] },
];
const reads = (name: string) => nameReads(workspace(), name, undefined, FLAGS).map((r) => r.flags);

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-owner-")));
  write(
    "flagrm.config.yaml",
    "projects:\n  - name: web\n    adapter: angular\n    path: web\n    build: false\n    test: false\n" +
      "  - name: api\n    adapter: dotnet\n    path: api\n    build: false\n    test: false\n",
  );
  write("web/flags.ts", "export enum FeatureFlags {\n  Paging = 'Paging',\n  PagingV2 = 'PagingV2',\n}\n");
  write(
    "web/list.ts",
    [
      "export class List {",
      "  pagedV2Eval = this.flags.isEnabled(FeatureFlags.PagingV2);",
      "  readonly pagedTyped: boolean = this.flags.isEnabled('Paging');",
      "  get pagedGetter(): boolean {",
      "    return this.flags.isEnabled(FeatureFlags.PagingV2);",
      "  }",
      "  pagedArrow = () => this.flags.isEnabled(FeatureFlags.Paging) && this.flags.isEnabled(FeatureFlags.PagingV2);",
      "  // pagedComment = this.flags.isEnabled(FeatureFlags.PagingV2);",
      "  pagedString = 'FeatureFlags.PagingV2 is read elsewhere';",
      "  pagedPassed = this.input;",
      "  show() { return this.cond ? pagedV2Eval : 'Paging'; }",
      "}",
      "",
    ].join("\n"),
  );
  write(
    "api/Paging.cs",
    [
      "public class Paging {",
      '    public bool PagedProp => _features.IsEnabled("PagingV2");',
      '    public bool PagedMethod() { return _features.IsEnabled("Paging"); }',
      "    void M(string s) { switch (s) { case PagedProp: break; } }",
      "}",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("nameReads", () => {
  it("finds the flags read where a name is declared or assigned, in TS and C#", () => {
    expect(reads("pagedV2Eval")).toEqual([["PagingV2"]]);
    expect(reads("pagedTyped")).toEqual([["Paging"]]);
    expect(reads("pagedGetter")).toEqual([["PagingV2"]]);
    expect(reads("pagedArrow")).toEqual([["Paging", "PagingV2"]]);
    expect(reads("PagedProp")).toEqual([["PagingV2"]]);
    expect(reads("PagedMethod")).toEqual([["Paging"]]);
  });

  it("ignores comments, a qualified name inside a string, ternary branches and case labels", () => {
    expect(reads("pagedString")).toEqual([[]]);
    expect(reads("pagedPassed")).toEqual([[]]);
    expect(reads("pagedComment")).toEqual([]);
  });

  it("looks only in the given files", () => {
    expect(nameReads(workspace(), "PagedProp", [path.join(tmp, "web/list.ts")], FLAGS)).toEqual([]);
  });
});

describe("assertOwnNames", () => {
  const agent = (name: string) => ({ name, kind: "wrapper" as const, source: "agent" as const });

  it("refuses a name whose code reads only another flag, naming it and where", async () => {
    await expect(assertOwnNames(tmp, workspace(), "Paging", [agent("pagedV2Eval")])).rejects.toThrow(
      '"pagedV2Eval" reads PagingV2, not Paging (web/list.ts:2); not recorded.',
    );
  });

  it("accepts a name reading this flag (with others or not), no flag, or a mix of sites", async () => {
    write("web/other.ts", "export const pagedV2Eval = this.flags.isEnabled('Paging');\n");
    await expect(
      assertOwnNames(tmp, workspace(), "Paging", [
        agent("pagedArrow"),
        agent("pagedPassed"),
        agent("pagedV2Eval"),
        agent("nowhere"),
      ]),
    ).resolves.toBeUndefined();
  });
});
