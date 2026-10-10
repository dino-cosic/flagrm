import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverFlag, writeBaseline } from "../src/core/baseline.js";
import { loadConfig } from "../src/core/config.js";
import { gitState } from "../src/core/git.js";
import { buildInventory } from "../src/core/inventory.js";
import { resolveProjects } from "../src/core/registry.js";
import { verifyFlag } from "../src/core/verify/index.js";

let tmp: string;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};
const lines = (...source: string[]) => `${source.join("\n")}\n`;
const config = (methods: string) =>
  `projects:\n  - name: web\n    adapter: angular\n    path: .\n${methods}    build: false\n    test: false\n`;
// Call after writing the files: a project's file list is read when its context is created.
const workspace = () => resolveProjects(loadConfig({ quiet: true }, tmp));
const rel = (file: string) => path.relative(tmp, file).split(path.sep).join("/");

/** A flag's flow names other than import aliases, as `kind name file:line`, sorted. */
async function flowOf(flag = "Pagination"): Promise<string[]> {
  const entry = (await buildInventory(workspace())).flags.find((f) => f.flag === flag);
  return (entry?.flow ?? [])
    .filter((n) => n.kind !== "alias")
    .map((n) => `${n.kind} ${n.name} ${rel(n.file)}:${n.line}${n.ambiguous ? " ambiguous" : ""}`)
    .sort();
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-ng-value-")));
  write("flagrm.config.yaml", config("    methods: [isFeatureFlagEnabled]\n"));
  write(
    "src/app/feature-flags.ts",
    "export enum FeatureFlags {\n  Pagination = 'Pagination',\n  Other = 'Other',\n}\n",
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Angular holders", () => {
  it("finds fields, assignments, getters, parameterless methods and locals holding an evaluation", async () => {
    write(
      "src/app/a.component.ts",
      lines(
        "import { FeatureFlags } from './feature-flags';",
        "export class AComponent {",
        "  isPaginationEnabled = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "  pagingOff = !(this.ff.isFeatureFlagEnabled('Pagination'));",
        "  pagingOptional = this.ff?.isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "  pagingInjected = inject(FlagService).isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "  pagedInCtor: boolean;",
        "  pagedOnInit = false;",
        "  constructor(private ff: FlagService) {",
        "    this.pagedInCtor = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "  }",
        "  ngOnInit() {",
        "    this.pagedOnInit = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "    const pagingLocal = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "  }",
        "  get pagingGetter() { return this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination); }",
        "  get pagingLabel() { return this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination) ? 'Pages' : 'All'; }",
        "  pagingMethod() { return this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination); }",
        "}",
      ),
    );
    expect(await flowOf()).toEqual(
      [
        "field isPaginationEnabled src/app/a.component.ts:3",
        "field pagingOff src/app/a.component.ts:4",
        "field pagingOptional src/app/a.component.ts:5",
        "field pagingInjected src/app/a.component.ts:6",
        "field pagedInCtor src/app/a.component.ts:10",
        "field pagedOnInit src/app/a.component.ts:13",
        "local pagingLocal src/app/a.component.ts:14",
        "property pagingGetter src/app/a.component.ts:16",
        "property pagingLabel src/app/a.component.ts:17",
        "method pagingMethod src/app/a.component.ts:18",
      ].sort(),
    );
  });

  it("follows names whose value is a holder of the same class or function, but not a ternary or another class", async () => {
    write(
      "src/app/a.component.ts",
      lines(
        "import { FeatureFlags } from './feature-flags';",
        "export class AComponent {",
        "  paging = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "  pagingOff = !this.paging;",
        "  pagingRead = this.paging();",
        "  get pagingGetter() { return this.pagingOff; }",
        "  pagingMethod() { return !this.pagingGetter; }",
        "  get pagingLabel() { return this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination) ? 'Pages' : 'All'; }",
        "  label = this.pagingLabel;",
        "  mixed = this.paging && this.rows > 10;",
        "  run() {",
        "    const pagingLocal = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "    const pagingCopy = !pagingLocal;",
        "    const pagingField = this.paging;",
        "  }",
        "  other() {",
        "    const pagingLocal2 = pagingLocal;",
        "  }",
        "}",
        "export class BComponent {",
        "  copy = this.paging;",
        "}",
      ),
    );
    expect(await flowOf()).toEqual(
      [
        "field paging src/app/a.component.ts:3",
        "field pagingOff src/app/a.component.ts:4",
        "field pagingRead src/app/a.component.ts:5",
        "property pagingGetter src/app/a.component.ts:6",
        "method pagingMethod src/app/a.component.ts:7",
        "property pagingLabel src/app/a.component.ts:8",
        "local pagingLocal src/app/a.component.ts:12",
        "local pagingCopy src/app/a.component.ts:13",
        "local pagingField src/app/a.component.ts:14",
      ].sort(),
    );
  });

  it("skips composites, methods with parameters, eval-method names, other flags and test files", async () => {
    write(
      "src/app/b.component.ts",
      lines(
        "export class BComponent {",
        "  combined = this.ff.isFeatureFlagEnabled('Pagination') && this.rows > 10;",
        "  other = this.ff.isFeatureFlagEnabled('Other');",
        "  pagingFor(id: string) { return this.ff.isFeatureFlagEnabled('Pagination'); }",
        "  isFeatureFlagEnabled() { return this.ff.isFeatureFlagEnabled('Pagination'); }",
        "  pagingTwice() { this.log(); return this.ff.isFeatureFlagEnabled('Pagination'); }",
        "}",
      ),
    );
    write(
      "src/app/b.component.spec.ts",
      lines("it('pages', () => {", "  const pagingSpec = ff.isFeatureFlagEnabled('Pagination');", "});"),
    );
    expect(await flowOf()).toEqual([]);
    expect(await flowOf("Other")).toEqual(["field other src/app/b.component.ts:3"]);
  });

  it("finds nothing when the eval method is not configured", async () => {
    write("flagrm.config.yaml", config(""));
    write(
      "src/app/a.component.ts",
      lines("export class AComponent {", "  paging = this.ff.isFeatureFlagEnabled('Pagination');", "}"),
    );
    expect(await flowOf()).toEqual([]);
  });

  it("matches an import alias only in the file that imports it", async () => {
    write(
      "src/app/c.component.ts",
      lines(
        "import { FeatureFlags as Flags } from './feature-flags';",
        "export class CComponent {",
        "  pagingAliased = this.ff.isFeatureFlagEnabled(Flags.Pagination);",
        "}",
      ),
    );
    write(
      "src/app/d.component.ts",
      lines("export class DComponent {", "  pagingElsewhere = this.ff.isFeatureFlagEnabled(Flags.Pagination);", "}"),
    );
    expect(await flowOf()).toEqual(["field pagingAliased src/app/c.component.ts:3"]);
  });

  it("still follows a renamed import next to a default import", async () => {
    write(
      "src/app/e.ts",
      lines("import Registry, { FeatureFlags as Flags } from './feature-flags';", "export const p = Flags.Pagination;"),
    );
    const entry = (await buildInventory(workspace())).flags.find((f) => f.flag === "Pagination");
    expect(entry?.flow.map((n) => n.name)).toContain("Flags.Pagination");
  });
});

describe("Angular child inputs", () => {
  it("follows a holder bound in a parent's templateUrl to every kind of input, one hop only", async () => {
    write(
      "src/app/parent.component.ts",
      lines(
        "import { Component } from '@angular/core';",
        "import { FeatureFlags } from './feature-flags';",
        "@Component({ selector: 'app-parent', templateUrl: './parent.component.html' })",
        "export class ParentComponent {",
        "  isPaginationEnabled = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "  get pagingLabel() { return this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination) ? 'Pages' : 'All'; }",
        "  run() { const pagingLocal = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination); }",
        "}",
      ),
    );
    write(
      "src/app/parent.component.html",
      lines(
        "<app-list",
        '  [paged]="isPaginationEnabled"',
        '  [required]="isPaginationEnabled"',
        '  [aliased]="!isPaginationEnabled"',
        '  [aliasedObj]="isPaginationEnabled"',
        '  [viaSetter]="isPaginationEnabled"',
        "  [signalPaged]='isPaginationEnabled'",
        '  [signalRequired]="isPaginationEnabled"',
        '  [signalAlias]="isPaginationEnabled"',
        '  [modelPaged]="isPaginationEnabled"',
        '  [hello]="isPaginationEnabled"',
        '  [label]="pagingLabel"',
        '  [local]="pagingLocal"',
        '  [mixed]="isPaginationEnabled && rows"',
        "/>",
      ),
    );
    write(
      "src/app/list.component.ts",
      lines(
        "import { Component, Input, input, model } from '@angular/core';",
        "@Component({ selector: 'app-list', template: '<app-row [paged]=\"paged\"></app-row>' })",
        "export class ListComponent {",
        "  @Input() paged = false;",
        "  @Input({ required: true }) required!: boolean;",
        "  @Input('aliased') renamed = false;",
        "  @Input({ alias: 'aliasedObj' }) renamedObj = false;",
        "  @Input() set viaSetter(v: boolean) {}",
        "  signalPaged = input(false);",
        "  signalRequired = input.required<boolean>();",
        "  signalAliased = input(false, { alias: 'signalAlias' });",
        "  modelPaged = model(false);",
        "  greeting = input('hello');",
        "  label = input('');",
        "  local = input(false);",
        "  mixed = input(false);",
        "  get showPaging() { return this.signalPaged(); }",
        "}",
      ),
    );
    write(
      "src/app/row.component.ts",
      lines(
        "import { Component, Input } from '@angular/core';",
        "@Component({ selector: 'app-row', template: '' })",
        "export class RowComponent {",
        "  @Input() paged = false;",
        "}",
      ),
    );
    expect(await flowOf()).toEqual(
      [
        "field isPaginationEnabled src/app/parent.component.ts:5",
        "property pagingLabel src/app/parent.component.ts:6",
        "local pagingLocal src/app/parent.component.ts:7",
        "field paged src/app/list.component.ts:4",
        "field required src/app/list.component.ts:5",
        "field renamed src/app/list.component.ts:6",
        "field renamedObj src/app/list.component.ts:7",
        "field viaSetter src/app/list.component.ts:8",
        "field signalPaged src/app/list.component.ts:9",
        "field signalRequired src/app/list.component.ts:10",
        "field signalAliased src/app/list.component.ts:11",
        "field modelPaged src/app/list.component.ts:12",
        "property showPaging src/app/list.component.ts:17",
      ].sort(),
    );
  });

  it("reads an inline template, each selector of a comma list, and ignores comments and attribute selectors", async () => {
    write(
      "src/app/inline.component.ts",
      lines(
        "import { Component } from '@angular/core';",
        "import { FeatureFlags } from './feature-flags';",
        "@Component({",
        "  selector: 'app-inline',",
        "  template: `",
        '    <!-- <app-alt [commented]="isPaginationEnabled"></app-alt> -->',
        '    <app-alt [paged]="isPaginationEnabled()"></app-alt>',
        '    <div appPaging [paged]="isPaginationEnabled"></div>',
        "  `,",
        "})",
        "export class InlineComponent {",
        "  isPaginationEnabled = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination);",
        "}",
      ),
    );
    write(
      "src/app/alt.component.ts",
      lines(
        "import { Component, Input } from '@angular/core';",
        "@Component({ selector: 'app-main, app-alt', template: '' })",
        "export class AltComponent {",
        "  @Input() paged = false;",
        "  @Input() commented = false;",
        "}",
      ),
    );
    write(
      "src/app/paging.directive.ts",
      lines(
        "import { Component, Input } from '@angular/core';",
        "@Component({ selector: '[appPaging]', template: '' })",
        "export class PagingAttrComponent {",
        "  @Input() paged = false;",
        "}",
      ),
    );
    expect(await flowOf()).toEqual(
      ["field isPaginationEnabled src/app/inline.component.ts:12", "field paged src/app/alt.component.ts:4"].sort(),
    );
  });

  it("marks an input ambiguous, and never records it, when two components share the selector", async () => {
    write(
      "src/app/parent.component.ts",
      lines(
        "import { Component } from '@angular/core';",
        "@Component({",
        "  selector: 'app-parent',",
        "  template: '<app-dup [paginationShown]=\"isPaginationEnabled\"></app-dup>',",
        "})",
        "export class ParentComponent {",
        "  isPaginationEnabled = this.ff.isFeatureFlagEnabled('Pagination');",
        "}",
      ),
    );
    for (const n of [1, 2]) {
      write(
        `src/app/dup${n}.component.ts`,
        lines(
          "import { Component, Input } from '@angular/core';",
          "@Component({ selector: 'app-dup', template: '' })",
          `export class Dup${n}Component {`,
          "  @Input() paginationShown = false;",
          "}",
        ),
      );
    }
    expect(await flowOf()).toEqual(
      [
        "field isPaginationEnabled src/app/parent.component.ts:7",
        "field paginationShown src/app/dup1.component.ts:4 ambiguous",
        "field paginationShown src/app/dup2.component.ts:4 ambiguous",
      ].sort(),
    );
    const entry = (await buildInventory(workspace())).flags.find((f) => f.flag === "Pagination");
    expect(entry?.flow.filter((n) => n.name === "paginationShown").map((n) => n.record)).toEqual([false, false]);
  });
});

describe("Angular value flow end to end", () => {
  const parent = (member: string) =>
    lines(
      "import { Component } from '@angular/core';",
      "import { FeatureFlags } from './feature-flags';",
      "@Component({ selector: 'app-parent', templateUrl: './parent.component.html' })",
      "export class ParentComponent {",
      member,
      "}",
    );

  beforeEach(() => {
    write(
      "src/app/parent.component.ts",
      parent("  isPaginationEnabled = this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination);"),
    );
    write("src/app/parent.component.html", '<app-row [enabled]="isPaginationEnabled"></app-row>\n');
    write(
      "src/app/row.component.ts",
      lines(
        "import { Component, Input } from '@angular/core';",
        "@Component({ selector: 'app-row', template: '' })",
        "export class RowComponent {",
        "  @Input() enabled = false;",
        "}",
      ),
    );
  });

  it("records a field holding the flag for its .ts and template, and suggests a generic input", async () => {
    const { names, suggestedNames } = await discoverFlag(workspace(), "Pagination");
    expect(names).toContainEqual({
      name: "isPaginationEnabled",
      kind: "wrapper",
      source: "discovery",
      file: "src/app/parent.component.ts",
    });
    expect(names).toContainEqual({
      name: "isPaginationEnabled",
      kind: "wrapper",
      source: "discovery",
      file: "src/app/parent.component.html",
    });
    expect(names.map((n) => n.name)).not.toContain("enabled");
    expect(suggestedNames.map((n) => `${n.kind} ${n.name}`)).toContain("field enabled");
  });

  it("only suggests a getter that names a one-word flag, as it would be checked everywhere", async () => {
    write(
      "src/app/parent.component.ts",
      parent("  get isPaginationEnabled() { return this.ff.isFeatureFlagEnabled(FeatureFlags.Pagination); }"),
    );
    const { names, suggestedNames } = await discoverFlag(workspace(), "Pagination");
    expect(names.map((n) => n.name)).not.toContain("isPaginationEnabled");
    expect(suggestedNames.map((n) => `${n.kind} ${n.name}`)).toContain("property isPaginationEnabled");
  });

  it("fails leftovers on the field left in the template", async () => {
    const projects = workspace();
    const { names } = await discoverFlag(projects, "Pagination");
    writeBaseline(tmp, "Pagination", projects, gitState(tmp), undefined, names);
    write("src/app/parent.component.ts", parent(""));
    write("src/app/feature-flags.ts", "export enum FeatureFlags {\n  Other = 'Other',\n}\n");
    const { report } = await verifyFlag(tmp, workspace(), "Pagination", { skip: ["build", "tests", "dead-code"] });
    const leftovers = report.checks.find((c) => c.id === "leftovers");
    expect(leftovers?.status).toBe("fail");
    expect(leftovers?.findings.map((f) => `${rel(f.file ?? "")} ${f.message}`)).toContain(
      "src/app/parent.component.html still references isPaginationEnabled",
    );
  });
});
