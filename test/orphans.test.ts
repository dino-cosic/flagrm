import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedFilesSince, headSha } from "../src/core/git.js";
import { getAdapter } from "../src/core/registry.js";
import type { Baseline } from "../src/core/types.js";
import type { VerifyContext } from "../src/core/verify/context.js";
import { orphanFindings } from "../src/core/verify/orphans.js";
import { projectContext } from "./support/projects.js";

let tmp: string;
let sha: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" }).trim();
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};

function context(): VerifyContext {
  const ctx = projectContext("generic", tmp, {
    globs: ["**/*.ts", "**/*.html", "**/*.cs", "**/*.cshtml", "**/appsettings*.json"],
  });
  return {
    root: tmp,
    flag: "NewCheckout",
    projects: [{ adapter: getAdapter("generic"), ctx }],
    baseline: {
      git: { sha, dirty: false },
      names: [{ name: "UseNewCheckout", kind: "wrapper", source: "discovery" }],
    } as unknown as Baseline,
    changedFiles: changedFilesSince(tmp, sha),
    runs: [],
    configChanges: [],
    originalConfigChanges: [],
  };
}
const messages = () =>
  orphanFindings(context()).map(
    (f) =>
      `${path
        .relative(tmp, f.file ?? "")
        .split(path.sep)
        .join("/")}:${f.line} ${f.message}`,
  );

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-orphans-")));
  git("init", "-q");
  write("legacy.ts", "export function legacyTotal(): number {\n  return 1;\n}\n");
  write("checkout.ts", "import { legacyTotal } from './legacy';\nexport const total = legacyTotal();\n");
  write("view.html", '<button [disabled]="isLocked">Pay</button>\n');
  write("view.ts", "export class View {\n  isLocked = false;\n  lock() { this.isLocked = true; }\n}\n");
  write(
    "Report.cs",
    'class Report {\n  string Total => "";\n  string Line() => $"{Total}";\n  string Old() => Total;\n}\n',
  );
  write(
    "Options.cs",
    "class CheckoutOptions {\n  public int Retries { get; set; }\n}\nclass Use {\n  int R(CheckoutOptions o) => o.Retries;\n}\n",
  );
  write("appsettings.json", '{ "Checkout": { "Retries": 3 } }\n');
  write("Banner.cs", 'class Banner {\n  public string Greeting => "hi";\n  string Show() => Greeting;\n}\n');
  write("Index.cshtml", "<p>@Model.Greeting</p>\n");
  write("Wrapper.cs", "class W {\n  bool UseNewCheckout() => true;\n  bool A() => UseNewCheckout();\n}\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
  sha = headSha(tmp) as string;
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("orphanFindings", () => {
  it("reports a declaration whose last reference the removal deleted", () => {
    write("checkout.ts", "export const total = 1;\n");
    expect(messages()).toEqual([
      "legacy.ts:1 legacyTotal is now referenced only where it is declared: delete it if only the OFF path used it",
    ]);
  });

  it("counts a template attribute and an interpolated string as references", () => {
    write("view.ts", "export class View {\n  isLocked = false;\n}\n");
    write("Report.cs", 'class Report {\n  string Total => "";\n  string Line() => $"{Total}";\n}\n');
    expect(messages()).toEqual([]);
  });

  it("counts Razor views and appsettings binding as references", () => {
    // The code no longer reads Retries; appsettings still binds it.
    write(
      "Options.cs",
      "class CheckoutOptions {\n  public int Retries { get; set; }\n}\nclass Use {\n  int R(CheckoutOptions o) => 0;\n}\n",
    );
    write("Banner.cs", 'class Banner {\n  public string Greeting => "hi";\n}\n');
    expect(messages()).toEqual([]);
  });

  it("ignores keywords, of which the removal may leave just one", () => {
    // `lock() { this.isLocked = true; }` goes; Wrapper.cs keeps the project's last `true`.
    write("view.ts", "export class View {\n  isLocked = false;\n  lock() {}\n}\n");
    expect(messages()).toEqual([]);
  });

  it("reports only a declaration, not the last use of a library member, an object key or an import", () => {
    write("Lib.cs", "class T {\n  void A(M m) { m.Setup(1); m.Setup(2); }\n}\n");
    write(
      "spec.ts",
      "const p = [{ provide: Api, useValue: api }];\nconst q = [{ provide: Other, useValue: other }];\n",
    );
    write("imp.ts", "import { Shared } from 'lib';\nconst a = new Shared();\n");
    write("tpl.ts", "const template = `<li>Review item(s)</li><li>one item</li>`;\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "more");
    sha = headSha(tmp) as string;
    write("Lib.cs", "class T {\n  void A(M m) { m.Setup(1); }\n}\n");
    write("spec.ts", "const p = [{ provide: Api, useValue: api }];\n");
    write("imp.ts", "import { Shared } from 'lib';\n");
    write("tpl.ts", "const template = `<li>Review item(s)</li>`;\n");
    expect(messages()).toEqual([]);
  });

  it("recognizes C# members and types, and TypeScript functions, fields and methods, as declarations", () => {
    write(
      "Svc.cs",
      "class LegacyPricer {\n  public decimal OldPrice(int n) => n;\n  internal string Label { get; set; }\n}\n",
    );
    write("comp.ts", "export class C {\n  oldBanner = '';\n  legacyHint: string;\n  showLegacy(): void {\n  }\n}\n");
    write("uses.ts", "new LegacyPricer().OldPrice(1); x.Label; c.oldBanner; c.legacyHint; c.showLegacy();\n");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "more");
    sha = headSha(tmp) as string;
    write("uses.ts", "export {};\n");
    expect(messages().map((m) => m.split(" is now")[0])).toEqual([
      "Svc.cs:3 Label",
      "Svc.cs:1 LegacyPricer",
      "Svc.cs:2 OldPrice",
      "comp.ts:3 legacyHint",
      "comp.ts:2 oldBanner",
      "comp.ts:4 showLegacy",
    ]);
  });

  it("counts a comment mention as no reference", () => {
    write("checkout.ts", "// legacyTotal() was the OFF path\nexport const total = 1;\n");
    expect(messages()).toHaveLength(1);
  });

  it("leaves the flag's recorded names to the leftovers check", () => {
    write("Wrapper.cs", "class W {\n  bool UseNewCheckout() => true;\n  bool A() => true;\n}\n");
    expect(messages()).toEqual([]);
  });

  it("reports nothing for a declaration deleted along with its references", () => {
    write("checkout.ts", "export const total = 1;\n");
    fs.rmSync(path.join(tmp, "legacy.ts"));
    expect(messages()).toEqual([]);
  });

  it("reports nothing without a baseline commit", () => {
    write("checkout.ts", "export const total = 1;\n");
    const v = context();
    const noGit = { ...v, baseline: { ...v.baseline, git: { sha: null, dirty: false } }, changedFiles: undefined };
    expect(orphanFindings(noGit)).toEqual([]);
  });
});
