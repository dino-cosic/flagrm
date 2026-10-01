import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { declaredName } from "../src/adapters/generic/text.js";
import { discoverNames, writeBaseline } from "../src/core/baseline.js";
import { loadConfig, type ToolConfig } from "../src/core/config.js";
import { gitState } from "../src/core/git.js";
import { buildInventory } from "../src/core/inventory.js";
import { resolveProjects } from "../src/core/registry.js";
import type { CheckId, VerifyReport } from "../src/core/types.js";
import { verifyFlag } from "../src/core/verify/index.js";

// The generic adapter on test/fixtures/generic-go.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "fixtures", "generic-go");
const FLAG = "new-checkout";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-generic-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function workspace(dir: string, adjust?: (config: ToolConfig) => void) {
  const config = loadConfig({}, dir);
  adjust?.(config);
  return resolveProjects(config);
}

describe("generic list on the Go fixture", () => {
  it("discovers flags from consts passed to eval methods and counts their references", async () => {
    const report = await buildInventory(workspace(path.join(FIXTURE, "before")));
    const flags = Object.fromEntries(report.flags.map((f) => [f.flag, f]));
    expect(Object.keys(flags)).toEqual(["dark-mode", "new-checkout"]);
    expect(flags[FLAG].definitions.map((d) => `${d.kind} ${d.name} ${d.line}`)).toEqual(["const NewCheckout 5"]);
    // Two uses of `flags.NewCheckout` in tests, one in production, and the `"new-checkout"` literal.
    expect(flags[FLAG].references).toMatchObject({ total: 4, files: 2, tests: 2 });
    // `flags.DarkMode` twice and the "DarkMode = false" message; `s.DarkMode()` is the method, not the const.
    expect(flags["dark-mode"].references).toMatchObject({ total: 3, tests: 2 });
  });
});

describe("declaredName", () => {
  const name = (line: string, file = "x.ts") => declaredName(line, line.indexOf('"'), file)?.name;

  it("finds the declared name across declaration styles", () => {
    expect(name('\tNewCheckout = "new-checkout"', "flags.go")).toBe("NewCheckout");
    expect(name('const NewCheckout FlagKey = "new-checkout"', "flags.go")).toBe("NewCheckout");
    expect(name('key := "new-checkout"', "main.go")).toBe("key");
    expect(name('public static final String NEW_CHECKOUT = "new-checkout";', "Flags.java")).toBe("NEW_CHECKOUT");
    expect(name('NEW_CHECKOUT: str = "new-checkout"', "flags.py")).toBe("NEW_CHECKOUT");
    expect(name('export const newCheckout: string = "new-checkout";')).toBe("newCheckout");
    expect(name('pub const NEW_CHECKOUT: &str = "new-checkout";', "flags.rs")).toBe("NEW_CHECKOUT");
  });

  it("ignores comparisons, keyword arguments and member assignments", () => {
    expect(name('if key == "new-checkout" {', "main.go")).toBeUndefined();
    expect(name('if (key != "new-checkout")')).toBeUndefined();
    expect(name('client.is_enabled(key="new-checkout")', "a.py")).toBeUndefined();
    expect(name('self.flag = "new-checkout"', "a.py")).toBeUndefined();
    expect(name('x += "new-checkout"')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe("verify on the Go fixture", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: tmp, encoding: "utf8" });

  beforeEach(() => {
    fs.cpSync(path.join(FIXTURE, "before"), tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, ".gitignore"), ".flagrm/\n");
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
  });

  function applyAfter(): void {
    const after = path.join(FIXTURE, "after");
    for (const rel of git("ls-files").split("\n").filter(Boolean)) {
      if (rel !== ".gitignore" && !fs.existsSync(path.join(after, rel))) fs.rmSync(path.join(tmp, rel));
    }
    fs.cpSync(after, tmp, { recursive: true });
  }

  async function verify(adjust?: (config: ToolConfig) => void, skip: CheckId[] = []): Promise<VerifyReport> {
    return (await verifyFlag(tmp, workspace(tmp, adjust), FLAG, { skip })).report;
  }

  const status = (report: VerifyReport) => Object.fromEntries(report.checks.map((c) => [c.id, c.status]));

  it("passes on the golden after/ copy with no commands configured", async () => {
    writeBaseline(tmp, FLAG, workspace(tmp), gitState(tmp), undefined, await discoverNames(workspace(tmp), FLAG));
    applyAfter();
    const report = await verify(undefined, ["build", "tests"]);
    expect(status(report)).toEqual({ leftovers: "pass", "dead-code": "skipped", build: "skipped", tests: "skipped" });
    expect(report.status).toBe("pass");
  });

  it("runs the configured build and test commands", async () => {
    const commands = (build: number, test: number) => (config: ToolConfig) => {
      config.projects[0].build = `node -e "process.exit(${build})"`;
      config.projects[0].test = `node -e "process.exit(${test})"`;
    };
    writeBaseline(tmp, FLAG, workspace(tmp), gitState(tmp), undefined, await discoverNames(workspace(tmp), FLAG));
    applyAfter();
    const ok = await verify(commands(0, 0));
    expect(status(ok)).toMatchObject({ build: "pass", tests: "pass" });
    const broken = await verify(commands(1, 2));
    expect(status(broken)).toMatchObject({ build: "fail", tests: "fail" });
    expect(broken.status).toBe("fail");
  });
});
