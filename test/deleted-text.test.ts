import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeBaseline } from "../src/core/baseline.js";
import { loadConfig } from "../src/core/config.js";
import { gitState } from "../src/core/git.js";
import { resolveProjects } from "../src/core/registry.js";
import { stringLiterals } from "../src/core/verify/deleted-text.js";
import { verifyFlag } from "../src/core/verify/index.js";

let tmp: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};

const CODE = "src/Core/PolicyNames.cs";
const TESTS = "test/Core.Test/PolicyNamesTests.cs";

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-deleted-")));
  write("flagrm.config.yaml", "projects:\n  - name: api\n    adapter: dotnet\n    path: .\n");
  write(".gitignore", ".flagrm/\n");
  write(
    CODE,
    `public static class PolicyNames
{
    public static string Sso(bool useVfo1) => useVfo1 ? "Require single sign-on (SSO)" : "Single sign-on authentication";
    public static string Single(bool useVfo1) => useVfo1 ? "Single organization" : "Single organization policy";
    public static string Plural(bool useVfo1) => useVfo1 ? "collections" : "shared folders";
    public const string Header = "Organization policies";
}
`,
  );
  write(
    TESTS,
    `public class PolicyNamesTests
{
    [Fact]
    public void Sso_Off() { Assert.Equal("Single sign-on authentication", PolicyNames.Sso(false)); }

    [Fact]
    public void Sso_On() { Assert.Equal("Require single sign-on (SSO)", PolicyNames.Sso(true)); }

    [Fact]
    public void Single_Off() { Assert.Equal("Single organization policy", PolicyNames.Single(false)); }

    [Fact]
    public void Plural_Off() { Assert.Equal("shared folders", PolicyNames.Plural(false)); }

    [Fact]
    public void Header() { Assert.Equal("Organization policies", PolicyNames.Header); }
}
`,
  );
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
  const projects = resolveProjects(loadConfig({}, tmp));
  writeBaseline(tmp, "pm-vfo1", projects, gitState(tmp), undefined, [
    { name: "pm-vfo1", kind: "literal", source: "discovery" },
  ]);
  // The removal: ON text kept, Header moved to another file. Sso_Off and Plural_Off are
  // deleted with the OFF path; Single_Off is left behind.
  write(
    CODE,
    `public static class PolicyNames
{
    public static string Sso() => "Require single sign-on (SSO)";
    public static string Single() => "Single organization";
    public static string Plural() => "collections";
}
`,
  );
  write(
    "src/Core/Headers.cs",
    'public static class Headers { public const string Policies = "Organization policies"; }\n',
  );
  write(
    TESTS,
    `public class PolicyNamesTests
{
    [Fact]
    public void Sso_On() { Assert.Equal("Require single sign-on (SSO)", PolicyNames.Sso()); }

    [Fact]
    public void Single_Off() { Assert.Equal("Single organization policy", PolicyNames.Single()); }

    [Fact]
    public void Header() { Assert.Equal("Organization policies", Headers.Policies); }
}
`,
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function leftovers() {
  const { report } = await verifyFlag(tmp, resolveProjects(loadConfig({}, tmp)), "pm-vfo1", {
    skip: ["build", "tests", "dead-code"],
  });
  return report.checks.find((c) => c.id === "leftovers");
}

describe("tests of deleted text", () => {
  it("warns about a test still checking text the removal deleted, and about ON text no test checks", async () => {
    const check = await leftovers();
    expect(check?.status).toBe("warn");
    expect(check?.summary).toContain("3 warnings about tests of deleted text");
    const lines = check?.findings.map((f) => `${f.file ? `${path.relative(tmp, f.file)}:${f.line} ` : ""}${f.message}`);
    expect(lines).toEqual([
      `${TESTS}:7 \`Single_Off\` checks "Single organization policy", which the removal deleted from ${CODE}: ` +
        "likely a test of the OFF path (the flag mock returns false by default); delete it",
      `a test checked "Single organization policy" (deleted from ${CODE}), but none checks "Single organization", ` +
        "the text kept on its line: the ON path lost its test coverage",
      `a test checked "shared folders" (deleted from ${CODE}), but none checks "collections", ` +
        "the text kept on its line: the ON path lost its test coverage",
    ]);
  });

  it("is quiet once the OFF test is deleted and the ON text has a test", async () => {
    write(
      TESTS,
      `public class PolicyNamesTests
{
    [Fact]
    public void Sso_On() { Assert.Equal("Require single sign-on (SSO)", PolicyNames.Sso()); }
    [Fact]
    public void Single_On() { Assert.Equal("Single organization", PolicyNames.Single()); }
    [Fact]
    public void Plural() { Assert.Equal("collections", PolicyNames.Plural()); }
}
`,
    );
    expect((await leftovers())?.status).toBe("pass");
  });
});

describe("stringLiterals", () => {
  it("keeps text, not identifiers, short values or interpolations", () => {
    const code = `var a = "Single organization policy"; var b = "id"; var c = $"Hello {name} there";
var d = @"Verbatim text"; var e = 'collections'; var f = "application/json"; var g = "12345678";`;
    expect(stringLiterals(code).map((l) => l.value)).toEqual([
      "Single organization policy",
      "Verbatim text",
      "collections",
      "application/json",
    ]);
  });
});
