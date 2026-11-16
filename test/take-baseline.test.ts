import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { takeBaseline } from "../src/core/baseline.js";
import { loadConfig } from "../src/core/config.js";
import { UsageError } from "../src/core/errors.js";
import { baselinePath } from "../src/core/paths.js";
import { resolveProjects } from "../src/core/registry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEFORE = path.resolve(HERE, "fixtures", "realistic", "before");
const FLAG = "NewCheckout";

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-take-")));
  fs.cpSync(BEFORE, dir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const take = (opts: Parameters<typeof takeBaseline>[3] = {}, flag = FLAG) =>
  takeBaseline(dir, resolveProjects(loadConfig({}, dir)), flag, { cwd: dir, ...opts });

/** Take a baseline without running checks; later calls then add to it. */
const initial = () => take({ checks: false });

async function usageError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UsageError);
  return (err as Error).message;
}

describe("takeBaseline", () => {
  it("writes a new baseline with the discovered names and no checks", async () => {
    const { baseline, file } = await initial();
    expect(file).toBe(baselinePath(dir, FLAG));
    expect(baseline.checks).toBeUndefined();
    expect(baseline.names[0]).toEqual({ name: FLAG, kind: "literal", source: "discovery" });
  });

  it("records --name --file as a wrapper for that file, and rejects --file without a wrapper --name", async () => {
    await initial();
    const file = path.join("backend", "src", "Shop.Api", "Services", "CheckoutService.cs");
    const { baseline } = await take({ names: ["useNew"], files: [file] });
    expect(baseline.names).toContainEqual({
      name: "useNew",
      kind: "wrapper",
      source: "agent",
      file: "backend/src/Shop.Api/Services/CheckoutService.cs",
    });
    expect(await usageError(take({ files: [file] }))).toContain("pass --name too");
    expect(await usageError(take({ names: ["useNew"], kind: "alias", files: [file] }))).toContain(
      "--file scopes wrapper names",
    );
  });

  it("repeats --file, adds a component's template once, and refuses a file outside the root", async () => {
    await initial();
    const ts = "frontend/src/app/checkout/checkout.component.ts";
    const html = "frontend/src/app/checkout/checkout.component.html";
    const steps = "frontend/src/app/checkout/checkout-steps.component.ts";
    const { baseline } = await take({ names: ["promoCode"], files: [ts, html, steps] });
    expect(baseline.names.filter((n) => n.name === "promoCode").map((n) => n.file)).toEqual([ts, html, steps]);
    expect(await usageError(take({ names: ["x"], files: [ts, "../elsewhere.ts"] }))).toContain(
      "--file ../elsewhere.ts is outside",
    );
  });

  it("refuses a name whose code reads only another flag, leaving the baseline as it was", async () => {
    const { file } = await initial();
    const before = fs.readFileSync(file, "utf8");
    const message = await usageError(
      take({ names: ["expressShipping"], files: ["frontend/src/app/checkout/checkout.component.ts"] }),
    );
    expect(message).toContain(
      '"expressShipping" reads ExpressShipping, not NewCheckout (frontend/src/app/checkout/checkout.component.ts:24); not recorded.',
    );
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("refuses a flag evaluation method as a name, and an unknown kind", async () => {
    expect(await usageError(take({ names: ["isEnabled"] }))).toContain("flag evaluation method");
    expect(await usageError(take({ names: ["X"], kind: "literal" }))).toContain("--kind must be alias or wrapper");
  });

  it("rejects --no-reuse with --no-checks, but not when only adding names", async () => {
    expect(await usageError(take({ checks: false, reuse: false }))).toContain("--no-reuse has nothing to reuse");
    await initial();
    const { baseline } = await take({ names: ["UseNewCheckout"], kind: "wrapper", reuse: false });
    expect(baseline.names).toContainEqual({ name: "UseNewCheckout", kind: "wrapper", source: "agent" });
  });

  it("--accept records the acknowledgement and refuses to mix with other changes", async () => {
    await initial();
    const { baseline } = await take({ accept: "config,failures" });
    expect(baseline.acceptedFailures).toBe(true);
    expect(baseline.acceptedConfig?.projects.map((p) => p.name)).toEqual(["web", "api"]);
    for (const extra of [{ force: true }, { names: ["X"] }, { checks: false }, { reuse: false }]) {
      expect(await usageError(take({ accept: "config", ...extra }))).toContain(
        "--accept only records an acknowledgement",
      );
    }
    expect(await usageError(take({ accept: "tests" }))).toContain('--accept takes config, failures; not "tests"');
    expect(await usageError(take({ accept: "config" }, "Missing"))).toContain("No baseline for Missing");
  });

  it("--force starts over only while the code is unedited since the baseline", async () => {
    const git = (...args: string[]) => spawnSync("git", args, { cwd: dir });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "before");
    const { file } = await initial();
    expect(await usageError(initial())).toContain("already exists; pass --name to add names, or --force to start over");
    await take({ checks: false, force: true });
    // A test result file the baseline's own run left behind (testResults) is not an edit.
    fs.mkdirSync(path.join(dir, "backend", "TestResults"));
    fs.writeFileSync(path.join(dir, "backend", "TestResults", "run.trx"), "<TestRun />\n");
    await take({ checks: false, force: true });
    const before = fs.readFileSync(file, "utf8");
    fs.appendFileSync(path.join(dir, "frontend", "src", "main.ts"), "\n// edited\n");
    const message = await usageError(take({ checks: false, force: true }));
    expect(message).toContain("frontend/src/main.ts");
    expect(message).toContain("git stash -u");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
