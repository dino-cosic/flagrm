import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { buildInventory } from "../src/core/inventory.js";
import { resolveProjects } from "../src/core/registry.js";
import type { FlagInventoryEntry, ListReport } from "../src/core/types.js";

// `flagrm list` against test/fixtures/realistic (see its README for the catalogue).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "fixtures", "realistic");

async function list(side: "before" | "after"): Promise<ListReport> {
  return buildInventory(resolveProjects(loadConfig({}, path.join(ROOT, side))));
}

let before: ListReport;
const rel = (file: string) => path.relative(path.join(ROOT, "before"), file).split(path.sep).join("/");
const flag = (report: ListReport, name: string): FlagInventoryEntry => {
  const entry = report.flags.find((f) => f.flag === name);
  expect(entry, name).toBeDefined();
  return entry!;
};

beforeAll(async () => {
  before = await list("before");
});

describe("list on the realistic fixture", () => {
  it("lists exactly the fixture's two flags, ignoring literals that only appear in tests", () => {
    expect(before.flags.map((f) => f.flag)).toEqual(["ExpressShipping", "NewCheckout"]);
    expect(before.projects).toEqual([
      { name: "web", adapter: "angular" },
      { name: "api", adapter: "dotnet" },
    ]);
  });

  it("finds every definition of NewCheckout in both projects", () => {
    const entry = flag(before, "NewCheckout");
    expect(entry.projects).toEqual(["web", "api"]);
    expect(entry.definitions.map((d) => `${d.project} ${d.kind} ${d.name} ${rel(d.file)}:${d.line}`)).toEqual([
      "web object-key FLAGS.newCheckout frontend/src/app/core/feature-flags.ts:3",
      "web enum-member FeatureFlag.NewCheckout frontend/src/app/core/feature-flags.ts:11",
      "api enum-member Feature.NewCheckout backend/src/Shop.Api/Features/Feature.cs:6",
      "api const FeatureFlags.NewCheckout backend/src/Shop.Api/Features/FeatureFlags.cs:8",
    ]);
  });

  it("reports the configured state per environment file", () => {
    const express = flag(before, "ExpressShipping");
    expect(express.config.map((c) => `${c.project} ${c.environment} ${c.state} ${rel(c.file)}`)).toEqual([
      "web prod off frontend/src/environments/environment.prod.ts",
      "web default on frontend/src/environments/environment.ts",
      "api Development on backend/src/Shop.Api/appsettings.Development.json",
      "api default off backend/src/Shop.Api/appsettings.json",
    ]);
    expect(express.type).toBe("boolean");
    expect(express.state).toBe("mixed");
    expect(flag(before, "NewCheckout").state).toBe("on");
  });

  it("counts references through the flag's literal and every definition alias", () => {
    // web: FLAGS.newCheckout ×6 (3 in specs) + FeatureFlag.NewCheckout in the route guard.
    // api: FeatureFlags.NewCheckout ×5 (2 in Moq setups) + nameof(Feature.NewCheckout).
    expect(flag(before, "NewCheckout").references).toEqual({
      total: 13,
      files: 9,
      tests: 5,
      byProject: { web: 7, api: 6 },
    });
  });

  it("drops NewCheckout from the golden after/ copy and keeps ExpressShipping intact", async () => {
    const after = await list("after");
    expect(after.flags.map((f) => f.flag)).toEqual(["ExpressShipping"]);
    const express = flag(after, "ExpressShipping");
    // The golden removal also deletes the two registries that only NewCheckout kept alive.
    expect(express.definitions.map((d) => d.name)).toEqual(["FLAGS.expressShipping", "FeatureFlags.ExpressShipping"]);
    expect(express.config).toHaveLength(4);
    expect(express.references).toEqual({ total: 7, files: 5, tests: 5, byProject: { web: 5, api: 2 } });
  });
});
