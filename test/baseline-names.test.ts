import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addNames,
  discoverNames,
  mergeNames,
  UsageError,
  validateAgentNames,
  writeBaseline,
} from "../src/core/baseline.js";
import { loadConfig } from "../src/core/config.js";
import { resolveProjects } from "../src/core/registry.js";
import type { RecordedName } from "../src/core/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEFORE = path.resolve(HERE, "fixtures", "realistic", "before");
const FLAG = "NewCheckout";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-names-")));
  fs.cpSync(BEFORE, tmp, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const workspace = () => resolveProjects(loadConfig({}, tmp));
const agent = (name: string, kind: RecordedName["kind"] = "wrapper"): RecordedName => ({ name, kind, source: "agent" });

describe("discoverNames", () => {
  it("records the flag literal first, then each definition's qualified name", async () => {
    const names = await discoverNames(workspace(), FLAG);
    expect(names[0]).toEqual({ name: FLAG, kind: "literal", source: "discovery" });
    const aliases = names.filter((n) => n.kind === "alias").map((n) => n.name);
    expect(aliases).toEqual(expect.arrayContaining(["FeatureFlags.NewCheckout", "FLAGS.newCheckout"]));
    expect(names.every((n) => n.source === "discovery")).toBe(true);
  });

  it("records only the literal for a flag discovery does not know", async () => {
    expect(await discoverNames(workspace(), "Nope")).toEqual([{ name: "Nope", kind: "literal", source: "discovery" }]);
  });
});

describe("mergeNames", () => {
  it("appends new names and keeps the first entry for a duplicate", () => {
    const existing: RecordedName[] = [{ name: FLAG, kind: "literal", source: "discovery" }];
    expect(mergeNames(existing, [agent(FLAG), agent("IsNewCheckoutEnabledAsync")])).toEqual([
      existing[0],
      agent("IsNewCheckoutEnabledAsync"),
    ]);
  });
});

describe("addNames", () => {
  it("adds names without touching the git state or checks", async () => {
    const git = { sha: "abc", dirty: false, dirtyFiles: [] };
    const checks = [{ project: "api", check: "build" as const, command: "x", exitCode: 0, durationMs: 1 }];
    writeBaseline(tmp, FLAG, workspace(), git, checks, await discoverNames(workspace(), FLAG));
    const { baseline } = addNames(tmp, FLAG, [agent("IsNewCheckoutEnabledAsync")]);
    expect(baseline.git).toEqual(git);
    expect(baseline.checks).toEqual(checks);
    expect(baseline.names.at(-1)).toEqual(agent("IsNewCheckoutEnabledAsync"));
    const again = addNames(tmp, FLAG, [agent("IsNewCheckoutEnabledAsync")]);
    expect(again.baseline.names.filter((n) => n.name === "IsNewCheckoutEnabledAsync")).toHaveLength(1);
  });

  it("throws a UsageError without a baseline", () => {
    expect(() => addNames(tmp, FLAG, [agent("X")])).toThrow(UsageError);
  });
});

describe("validateAgentNames", () => {
  it("rejects a name that is a configured flag evaluation method", () => {
    // realistic/before/flagrm.config.yaml configures `methods: [isEnabled, watch]` for the web project.
    expect(() => validateAgentNames(workspace(), [agent("isEnabled")])).toThrow(/flag evaluation method/);
  });

  it("accepts a wrapper name", () => {
    expect(() => validateAgentNames(workspace(), [agent("IsNewCheckoutEnabledAsync")])).not.toThrow();
  });
});
