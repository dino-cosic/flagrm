import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { buildInventory } from "../src/core/inventory.js";
import { resolveProjects } from "../src/core/registry.js";

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
