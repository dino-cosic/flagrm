import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { componentScopeFiles } from "../src/adapters/angular/component-files.js";
import { discoverFlag } from "../src/core/baseline.js";
import { loadConfig } from "../src/core/config.js";
import { resolveProjects } from "../src/core/registry.js";
import { withScopeFiles } from "../src/core/scope-files.js";

let tmp: string;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};
const workspace = () => resolveProjects(loadConfig({ quiet: true }, tmp));
const component = (decorator: string) =>
  `import { Component } from '@angular/core';\n@Component({ selector: 'app-list', ${decorator} })\nexport class ListComponent {\n  pagingOn = true;\n}\n`;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-scope-")));
  write(
    "flagrm.config.yaml",
    "projects:\n  - name: web\n    adapter: angular\n    path: .\n    build: false\n    test: false\n",
  );
  write("src/app/list.component.ts", component("templateUrl: './list.component.html'"));
  write("src/app/list.component.html", '<p *ngIf="pagingOn">paged</p>\n');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("scope files", () => {
  it("gives a component its templateUrl file", () => {
    const ts = path.join(tmp, "src/app/list.component.ts");
    expect(componentScopeFiles(ts)).toEqual([path.join(tmp, "src/app/list.component.html")]);
    expect(withScopeFiles(workspace(), tmp, "src/app/list.component.ts")).toEqual([
      "src/app/list.component.ts",
      "src/app/list.component.html",
    ]);
  });

  it("adds nothing for an inline template, a missing templateUrl file, or a non-component file", () => {
    write("src/app/list.component.ts", component("template: '<p>x</p>'"));
    expect(withScopeFiles(workspace(), tmp, "src/app/list.component.ts")).toEqual(["src/app/list.component.ts"]);
    write("src/app/list.component.ts", component("templateUrl: './gone.html'"));
    expect(withScopeFiles(workspace(), tmp, "src/app/list.component.ts")).toEqual(["src/app/list.component.ts"]);
    expect(withScopeFiles(workspace(), tmp, "src/app/list.component.html")).toEqual(["src/app/list.component.html"]);
  });

  it("records a discovered field for its component's template too", async () => {
    // Before workspace(): a project's file list is read when its context is created.
    write("src/app/flags.ts", "export enum FeatureFlags {\n  Paging = 'Paging',\n}\n");
    const [{ adapter, ctx }] = workspace();
    const field = {
      flag: "Paging",
      name: "pagingOn",
      kind: "field" as const,
      project: "web",
      file: path.join(tmp, "src/app/list.component.ts"),
      line: 4,
    };
    const projects = [{ adapter: { ...adapter, flow: () => ({ names: [field], tests: [] }) }, ctx }];
    const { names } = await discoverFlag(projects, "Paging");
    expect(names.filter((n) => n.name === "pagingOn")).toEqual([
      { name: "pagingOn", kind: "wrapper", source: "discovery", file: "src/app/list.component.ts" },
      { name: "pagingOn", kind: "wrapper", source: "discovery", file: "src/app/list.component.html" },
    ]);
  });
});
