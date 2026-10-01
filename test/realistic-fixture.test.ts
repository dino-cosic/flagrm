import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { describe, expect, it } from "vitest";

// Guards the invariants test/fixtures/realistic/README.md promises, so later
// phases can rely on before/ and after/ as a matched pair.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "fixtures", "realistic");
const BEFORE = path.join(ROOT, "before");
const AFTER = path.join(ROOT, "after");

const IGNORE = ["**/node_modules/**", "**/bin/**", "**/obj/**"];

function files(root: string): string[] {
  return fg.sync("**/*", { cwd: root, ignore: IGNORE, dot: false }).sort();
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function filesMatching(root: string, pattern: RegExp): string[] {
  return files(root).filter((rel) => pattern.test(read(root, rel)));
}

/** xUnit test cases: each [Fact] plus each [InlineData] row of a [Theory]. */
function countDotnetTests(root: string): number {
  return fg
    .sync("backend/tests/**/*.cs", { cwd: root, ignore: IGNORE })
    .reduce((n, rel) => n + (read(root, rel).match(/\[(Fact|InlineData)\b/g)?.length ?? 0), 0);
}

function countJasmineSpecs(root: string): number {
  return fg
    .sync("frontend/src/**/*.spec.ts", { cwd: root, ignore: IGNORE })
    .reduce((n, rel) => n + (read(root, rel).match(/^\s*it\(/gm)?.length ?? 0), 0);
}

describe("realistic fixture", () => {
  it("after/ only edits or deletes files from before/", () => {
    const before = new Set(files(BEFORE));
    expect(files(AFTER).filter((f) => !before.has(f))).toEqual([]);
  });

  it("before/ references NewCheckout in both projects", () => {
    const hits = filesMatching(BEFORE, /NewCheckout/i);
    expect(hits.some((f) => f.startsWith("backend/"))).toBe(true);
    expect(hits.some((f) => f.startsWith("frontend/"))).toBe(true);
  });

  it("after/ has no trace of NewCheckout, in any casing", () => {
    expect(filesMatching(AFTER, /newcheckout/i)).toEqual([]);
  });

  it("after/ keeps the ExpressShipping flag everywhere it is defined or configured", () => {
    for (const rel of [
      "backend/src/Shop.Api/Features/FeatureFlags.cs",
      "backend/src/Shop.Api/appsettings.json",
      "backend/src/Shop.Api/appsettings.Development.json",
      "frontend/src/app/core/feature-flags.ts",
      "frontend/src/environments/environment.ts",
      "frontend/src/environments/environment.prod.ts",
    ]) {
      expect(read(AFTER, rel), rel).toMatch(/ExpressShipping/);
    }
  });

  it("test counts match the README (OFF-path tests deleted, the rest kept)", () => {
    expect(countDotnetTests(BEFORE)).toBe(9);
    expect(countDotnetTests(AFTER)).toBe(5);
    expect(countJasmineSpecs(BEFORE)).toBe(8);
    expect(countJasmineSpecs(AFTER)).toBe(5);
  });
});
