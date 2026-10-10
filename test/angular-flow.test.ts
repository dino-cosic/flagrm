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
const workspace = () => resolveProjects(loadConfig({ quiet: true }, tmp));

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-ng-flow-")));
  write(
    "flagrm.config.yaml",
    "projects:\n  - name: web\n    adapter: angular\n    path: .\n    methods: [isFeatureFlagEnabled]\n    build: false\n    test: false\n",
  );
  write(
    "src/app/feature-flags.ts",
    "export enum FeatureFlags {\n  Pagination = 'Pagination',\n  Other = 'Other',\n}\n",
  );
  write(
    "src/app/list.component.ts",
    [
      "import { Component as NgComponent } from '@angular/core';",
      "import { FeatureFlags as AppFeatureFlags } from './feature-flags';",
      "export class ListComponent {",
      "  paged = this.flags.isFeatureFlagEnabled(AppFeatureFlags.Pagination);",
      "}",
      "",
    ].join("\n"),
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Angular import aliases", () => {
  it("follows a renamed import of a flag registry to its qualified names", async () => {
    const entry = (await buildInventory(workspace())).flags.find((f) => f.flag === "Pagination");
    expect(entry?.flow).toEqual([
      expect.objectContaining({ name: "AppFeatureFlags.Pagination", kind: "alias", record: true, line: 2 }),
    ]);
    const other = (await buildInventory(workspace())).flags.find((f) => f.flag === "Other");
    expect(other?.flow.map((n) => n.name)).toEqual(["AppFeatureFlags.Other"]);
  });

  it("adds nothing for a plain import or a renamed import of something else", async () => {
    write(
      "src/app/list.component.ts",
      "import { FeatureFlags } from './feature-flags';\nimport { Component as C } from '@angular/core';\n",
    );
    const entry = (await buildInventory(workspace())).flags.find((f) => f.flag === "Pagination");
    expect(entry?.flow).toEqual([]);
  });

  it("records the alias everywhere, and leftovers fails on it", async () => {
    const projects = workspace();
    const { names } = await discoverFlag(projects, "Pagination");
    expect(names).toContainEqual({ name: "AppFeatureFlags.Pagination", kind: "alias", source: "discovery" });
    writeBaseline(tmp, "Pagination", projects, gitState(tmp), undefined, names);
    write("src/app/feature-flags.ts", "export enum FeatureFlags {\n  Other = 'Other',\n}\n");
    const { report } = await verifyFlag(tmp, workspace(), "Pagination", { skip: ["build", "tests", "dead-code"] });
    const leftovers = report.checks.find((c) => c.id === "leftovers");
    expect(leftovers?.status).toBe("fail");
    expect(leftovers?.findings.map((f) => f.message)).toContain("still references AppFeatureFlags.Pagination");
  });
});
