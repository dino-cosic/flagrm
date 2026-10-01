import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectConfig, ToolConfig } from "../src/core/config.js";
import { createProjectContext, getAdapter } from "../src/core/registry.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-registry-"));
  fs.mkdirSync(path.join(tmp, "src"));
  fs.mkdirSync(path.join(tmp, "node_modules"));
  fs.mkdirSync(path.join(tmp, "coverage/src"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "src/Migrations"));
  for (const f of [
    "src/a.ts",
    "src/a.html",
    "src/b.cs",
    "src/c.go",
    "node_modules/x.ts",
    "coverage/src/a.ts.html",
    "src/Migrations/20260101_Init.cs",
    "src/Migrations/20260101_Init.Designer.cs",
    "src/Migrations/AppDbContextModelSnapshot.cs",
  ]) {
    fs.writeFileSync(path.join(tmp, f), "", "utf8");
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function project(overrides: Partial<ProjectConfig>): ProjectConfig {
  return { name: "p", adapter: "angular", path: tmp, methods: [], attributes: [], ...overrides };
}

function toolConfig(projects: ProjectConfig[]): ToolConfig {
  return { root: tmp, projects, exclude: [], include: [] };
}

const rel = (files: string[]): string[] => files.map((f) => path.relative(tmp, f).split(path.sep).join("/")).sort();

describe("adapter registry", () => {
  it("returns every adapter by id", () => {
    expect(getAdapter("angular").id).toBe("angular");
    expect(getAdapter("dotnet").id).toBe("dotnet");
    expect(getAdapter("generic").id).toBe("generic");
  });
});

describe("createProjectContext", () => {
  it("lists files with the adapter's default globs, skipping ignored directories", () => {
    const p = project({ name: "web", adapter: "angular" });
    const ctx = createProjectContext(p, toolConfig([p]));
    expect(ctx.name).toBe("web");
    expect(ctx.root).toBe(tmp);
    expect(rel(ctx.files)).toEqual(["src/a.html", "src/a.ts"]);
    expect(ctx.files).toContain(path.join(tmp, "src", "a.ts"));
  });

  it("skips coverage reports and EF Core migration metadata for .NET", () => {
    const p = project({ adapter: "dotnet" });
    expect(rel(createProjectContext(p, toolConfig([p])).files)).toEqual([
      "src/Migrations/20260101_Init.cs",
      "src/b.cs",
    ]);
  });

  it("uses the project's globs instead of the adapter defaults", () => {
    const p = project({ adapter: "dotnet", globs: ["**/*.go"] });
    expect(rel(createProjectContext(p, toolConfig([p])).files)).toEqual(["src/c.go"]);
  });

  it("lists every common source file for the generic adapter", () => {
    const p = project({ adapter: "generic" });
    expect(rel(createProjectContext(p, toolConfig([p])).files)).toEqual([
      "src/Migrations/20260101_Init.Designer.cs",
      "src/Migrations/20260101_Init.cs",
      "src/Migrations/AppDbContextModelSnapshot.cs",
      "src/a.html",
      "src/a.ts",
      "src/b.cs",
      "src/c.go",
    ]);
  });

  it("applies the global exclude list", () => {
    const p = project({ adapter: "angular" });
    const config = { ...toolConfig([p]), exclude: ["**/*.html"] };
    expect(rel(createProjectContext(p, config).files)).toEqual(["src/a.ts"]);
  });
});
