import path from "node:path";
import { describe, expect, it } from "vitest";
import { diagnoseUnusedTs } from "../src/adapters/angular/unused.js";
import { dotnetUnusedDiagnostics, parseDotnetUnused } from "../src/adapters/dotnet/unused.js";

describe("diagnoseUnusedTs", () => {
  it("reports unused imports and private members that the baseline version did not have", () => {
    const file = "/app/src/checkout.component.ts";
    const before = [
      "import { FLAGS } from './flags';",
      "export class C {",
      "  private stale = 1;", // already unused at the baseline: not new
      "  private legacy = 2;",
      "  run() { return FLAGS.x ? this.legacy : 0; }",
      "}",
    ].join("\n");
    const after = [
      "import { FLAGS } from './flags';",
      "export class C {",
      "  private stale = 1;",
      "  private legacy = 2;",
      "  run() { return 0; }",
      "}",
    ].join("\n");
    const result = diagnoseUnusedTs([{ file, text: after, baseline: before }]);
    expect(result.map((d) => [d.code, d.line, d.message])).toEqual([
      ["TS6133", 1, "'FLAGS' is declared but its value is never read."],
      ["TS6133", 4, "'legacy' is declared but its value is never read."],
    ]);
  });

  it("diagnoses Windows paths and reports them as given", () => {
    const file = "C:\\app\\src\\checkout.component.ts";
    const result = diagnoseUnusedTs([{ file, text: "import { FLAGS } from './flags';\nexport const x = 1;\n" }]);
    expect(result.map((d) => [d.file, d.code, d.line])).toEqual([[file, "TS6133", 1]]);
  });
});

describe("parseDotnetUnused", () => {
  const log = [
    "/src/Api/Services/CheckoutService.cs(11,46): warning CS0169: The field 'CheckoutService._legacy' is never used [/src/Api/Api.csproj]",
    "/src/Api/Services/CheckoutService.cs(12,20): warning CS0414: The field 'CheckoutService._count' is assigned but its value is never used [/src/Api/Api.csproj]",
    "/src/Api/Services/Other.cs(3,1): warning IDE0051: Private member 'Other.Unused' is unused [/src/Api/Api.csproj]",
    "/src/Api/Services/CheckoutService.cs(9,1): warning CS8618: Non-nullable field [/src/Api/Api.csproj]",
    // dotnet repeats warnings in the build summary
    "/src/Api/Services/CheckoutService.cs(11,46): warning CS0169: The field 'CheckoutService._legacy' is never used [/src/Api/Api.csproj]",
  ].join("\n");

  it("keeps unused-code warnings in the changed files, once each", () => {
    expect(parseDotnetUnused(log, ["/src/Api/Services/CheckoutService.cs"])).toEqual([
      {
        file: path.resolve("/src/Api/Services/CheckoutService.cs"),
        line: 11,
        code: "CS0169",
        message: "The field 'CheckoutService._legacy' is never used",
      },
      {
        file: path.resolve("/src/Api/Services/CheckoutService.cs"),
        line: 12,
        code: "CS0414",
        message: "The field 'CheckoutService._count' is assigned but its value is never used",
      },
    ]);
  });

  it("counts occurrences against the baseline: a second identical warning is new", () => {
    const warning = (line: number) =>
      `/src/Api/A.cs(${line},9): warning CS0168: The variable 'ex' is declared but never used [/src/Api/Api.csproj]`;
    const input = { changedFiles: ["/src/Api/A.cs"], baselineBuildLog: warning(10) };
    expect(dotnetUnusedDiagnostics({ ...input, buildLog: warning(12) })?.diagnostics).toEqual([]);
    expect(dotnetUnusedDiagnostics({ ...input, buildLog: `${warning(12)}\n${warning(30)}` })?.diagnostics).toEqual([
      expect.objectContaining({ code: "CS0168", line: 30 }),
    ]);
  });

  it("reports an unread primary-constructor parameter, also when warnings are errors", () => {
    const line =
      "/src/Api/Jobs/UpdateJob.cs(13,21): error CS9113: Parameter 'featureService' is unread. [/src/Api/Api.csproj]";
    expect(parseDotnetUnused(line, ["/src/Api/Jobs/UpdateJob.cs"])).toEqual([
      {
        file: path.resolve("/src/Api/Jobs/UpdateJob.cs"),
        line: 13,
        code: "CS9113",
        message: "Parameter 'featureService' is unread.",
      },
    ]);
  });
});
