import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type LaunchDarklyConfig, loadConfig } from "../src/core/config.js";
import { buildInventory } from "../src/core/inventory.js";
import { resolveProjects } from "../src/core/registry.js";
import { LaunchDarklySource } from "../src/core/sources/launchdarkly.js";
import type { SourceEnvironment, SourceFlag, SourceRead } from "../src/core/sources/types.js";
import { closestNames, evaluateStale, matchKeys, needsHistory, UnknownFlagError } from "../src/core/stale.js";

const NOW = new Date(Date.UTC(2026, 9, 1));
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const config = (over: Partial<LaunchDarklyConfig> = {}): LaunchDarklyConfig => ({
  project: "shop",
  baseUrl: "https://ld.test",
  tokenEnv: "LD_API_TOKEN",
  minDaysOn: 30,
  temporaryOnly: true,
  tags: { include: [], exclude: [] },
  map: {},
  ...over,
});

const on = (days: number): SourceEnvironment => ({
  serves: { kind: "fixed", value: true },
  since: daysAgo(days),
  sinceSource: "audit",
});

const flag = (key: string, over: Partial<SourceFlag> = {}): SourceFlag => ({
  key,
  name: key,
  kind: "boolean",
  temporary: true,
  tags: [],
  creationDate: daysAgo(200),
  environments: { production: on(40), staging: on(60) },
  ...over,
});

const read = (...flags: SourceFlag[]): SourceRead => ({ environments: ["production", "staging"], flags });

const evaluate = (r: SourceRead, codeNames: string[], over: Partial<LaunchDarklyConfig> = {}, only?: string[]) =>
  evaluateStale({ project: "shop", read: r, codeNames, config: config(over), now: NOW, only });

const one = (r: SourceRead, codeNames: string[], over: Partial<LaunchDarklyConfig> = {}) =>
  evaluate(r, codeNames, over).flags[0];

describe("matchKeys", () => {
  it("matches a kebab-case key to a PascalCase code name", () => {
    expect(matchKeys(["new-checkout"], ["NewCheckout"], {}).get("new-checkout")).toEqual({
      kind: "matched",
      codeName: "NewCheckout",
    });
  });

  it("lets a map entry win", () => {
    const m = matchKeys(["checkout-v2", "new-checkout"], ["NewCheckout"], { "checkout-v2": "NewCheckout" });
    expect(m.get("checkout-v2")).toEqual({ kind: "matched", codeName: "NewCheckout" });
    expect(m.get("new-checkout")).toEqual({ kind: "none" });
  });

  it("lets an exact match win over a normalized one", () => {
    const m = matchKeys(["NewCheckout", "new-checkout"], ["NewCheckout"], {});
    expect(m.get("NewCheckout")).toEqual({ kind: "matched", codeName: "NewCheckout" });
    expect(m.get("new-checkout")).toEqual({ kind: "none" });
  });

  it("calls two code names for one key ambiguous", () => {
    const m = matchKeys(["new-checkout"], ["NewCheckout", "new_checkout"], {});
    expect(m.get("new-checkout")).toMatchObject({ kind: "ambiguous" });
    expect((m.get("new-checkout") as { reason: string }).reason).toContain('"NewCheckout", "new_checkout"');
  });

  it("calls two keys for one code name ambiguous, naming the other key", () => {
    const m = matchKeys(["new-checkout", "new_checkout"], ["NewCheckout"], {});
    expect((m.get("new-checkout") as { reason: string }).reason).toContain('"new-checkout", "new_checkout"');
    expect(m.get("new_checkout")).toMatchObject({ kind: "ambiguous" });
  });

  it("says when a map entry names a code name that doesn't exist", () => {
    expect(matchKeys(["checkout-v2"], ["NewCheckout"], { "checkout-v2": "NewChekout" }).get("checkout-v2")).toEqual({
      kind: "none",
      reason: `map names "NewChekout", which the code doesn't define or use`,
    });
  });
});

describe("evaluateStale — removal conditions", () => {
  it("on everywhere long enough: remove", () => {
    expect(one(read(flag("new-checkout")), ["NewCheckout"])).toMatchObject({
      key: "new-checkout",
      codeName: "NewCheckout",
      verdict: "remove",
      reasons: [],
    });
  });

  it("recently turned on in one environment: keep, naming it and the days", () => {
    const f = flag("new-checkout", { environments: { production: on(10), staging: on(60) } });
    expect(one(read(f), ["NewCheckout"])).toMatchObject({
      verdict: "keep",
      reasons: ["production: true for only 10 days (needs 30)"],
    });
  });

  it("still targeted: keep, naming the environment", () => {
    const f = flag("new-checkout", {
      environments: { production: { serves: { kind: "targeted", detail: "1 rule(s)" } }, staging: on(60) },
    });
    expect(one(read(f), ["NewCheckout"]).reasons).toEqual(["production: targeted (1 rule(s))"]);
  });

  it("serving false: keep", () => {
    const f = flag("new-checkout", {
      environments: { production: { serves: { kind: "fixed", value: false }, since: daysAgo(90) }, staging: on(60) },
    });
    expect(one(read(f), ["NewCheckout"]).reasons).toEqual(["production: serves false"]);
  });

  it("permanent flag: keep unless temporaryOnly is off", () => {
    const f = flag("new-checkout", { temporary: false });
    expect(one(read(f), ["NewCheckout"]).reasons).toEqual(["permanent: not marked temporary in LaunchDarkly"]);
    expect(one(read(f), ["NewCheckout"], { temporaryOnly: false }).verdict).toBe("remove");
  });

  it("excluded or missing tags: keep, naming the tag", () => {
    const f = flag("new-checkout", { tags: ["keep"] });
    expect(one(read(f), ["NewCheckout"], { tags: { include: [], exclude: ["keep"] } }).reasons).toEqual([
      'has excluded tag "keep"',
    ]);
    expect(one(read(f), ["NewCheckout"], { tags: { include: ["cleanup"], exclude: [] } }).reasons).toEqual([
      'lacks tag "cleanup"',
    ]);
  });

  it("a multivariate flag: keep", () => {
    const f = flag("theme", { kind: "multivariate" });
    expect(one(read(f), ["Theme"]).reasons).toContain("not a boolean flag (multivariate)");
  });

  it("unrecognized data: keep with the reason", () => {
    const f = flag("new-checkout", { unrecognized: "unrecognized LaunchDarkly data: no kind" });
    expect(one(read(f), ["NewCheckout"])).toMatchObject({
      verdict: "keep",
      reasons: ["unrecognized LaunchDarkly data: no kind"],
    });
  });

  it("counts whole days, rounded down, to the evaluation time", () => {
    const f = flag("new-checkout", {
      environments: {
        production: {
          serves: { kind: "fixed", value: true },
          since: new Date(NOW.getTime() - 29.9 * 86_400_000).toISOString(),
        },
        staging: on(60),
      },
    });
    const result = one(read(f), ["NewCheckout"]);
    expect(result.environments[0].days).toBe(29);
    expect(result.verdict).toBe("keep");
    expect(evaluate(read(f), ["NewCheckout"])).toEqual(evaluate(read(f), ["NewCheckout"]));
  });
});

describe("evaluateStale — verdicts", () => {
  it("no code name matches: unreferenced, whatever LaunchDarkly serves", () => {
    expect(one(read(flag("old-banner")), ["NewCheckout"])).toMatchObject({ verdict: "unreferenced", reasons: [] });
  });

  it("ambiguous: keep, asking for a map entry", () => {
    const result = one(read(flag("new-checkout")), ["NewCheckout", "new_checkout"]);
    expect(result.verdict).toBe("keep");
    expect(result.reasons[0]).toContain("launchdarkly.map");
  });

  it("sorts flags by key", () => {
    expect(evaluate(read(flag("b"), flag("a"), flag("c")), []).flags.map((f) => f.key)).toEqual(["a", "b", "c"]);
  });
});

describe("evaluateStale — flags asked for", () => {
  const r = read(flag("new-checkout"), flag("express-shipping"));

  it("evaluates only the named flags, by key or code name", () => {
    expect(evaluate(r, ["NewCheckout"], {}, ["NewCheckout"]).flags.map((f) => f.key)).toEqual(["new-checkout"]);
    expect(evaluate(r, ["NewCheckout"], {}, ["new-checkout"]).flags.map((f) => f.key)).toEqual(["new-checkout"]);
    expect(evaluate(r, [], {}, ["ExpressShipping"]).flags.map((f) => f.key)).toEqual(["express-shipping"]);
  });

  it("a code name without a LaunchDarkly flag: keep, explaining the fallback", () => {
    const result = evaluate(r, ["NewCheckout", "OldBanner"], {}, ["OldBanner"]).flags;
    expect(result).toEqual([
      {
        codeName: "OldBanner",
        verdict: "keep",
        reasons: [
          `no LaunchDarkly flag matches "OldBanner": if it was archived or deleted, the SDK serves the code's fallback value, which may be OFF`,
        ],
        environments: [],
      },
    ]);
  });

  it("a name nothing matches: a usage error naming the closest", () => {
    expect(() => evaluate(r, ["NewCheckout"], {}, ["NewChekout"])).toThrow(UnknownFlagError);
    expect(() => evaluate(r, ["NewCheckout"], {}, ["NewChekout"])).toThrow(
      'No LaunchDarkly flag or code name matches "NewChekout". Closest: new-checkout, NewCheckout, express-shipping.',
    );
  });
});

describe("needsHistory", () => {
  it("wants history only for a matched boolean flag serving true everywhere", () => {
    expect(needsHistory(flag("new-checkout"), config(), ["NewCheckout"])).toBe(true);
    expect(needsHistory(flag("old-banner"), config(), ["NewCheckout"])).toBe(false);
    expect(needsHistory(flag("new-checkout", { temporary: false }), config(), ["NewCheckout"])).toBe(false);
    const targeted = flag("new-checkout", {
      environments: { production: { serves: { kind: "targeted", detail: "x" } }, staging: on(1) },
    });
    expect(needsHistory(targeted, config(), ["NewCheckout"])).toBe(false);
    const mapped = config({ map: { "checkout-v2": "NewCheckout" } });
    expect(needsHistory(flag("checkout-v2"), mapped, ["NewCheckout"])).toBe(true);
  });
});

describe("closestNames", () => {
  it("ranks by normalized edit distance", () => {
    expect(closestNames("newchekout", ["ExpressShipping", "NewCheckout", "Other"])[0]).toBe("NewCheckout");
  });
});

describe("evaluateStale — realistic fixture", () => {
  it("NewCheckout is ready to remove, ExpressShipping is kept", async () => {
    const fixtures = path.join(import.meta.dirname, "fixtures");
    const ws = resolveProjects(loadConfig({ config: "realistic/before/flagrm.config.yaml", quiet: true }, fixtures));
    const codeNames = (await buildInventory(ws)).flags.map((f) => f.flag);
    const fixture = (name: string) => fs.readFileSync(path.join(fixtures, "launchdarkly", name), "utf8");
    const fetch = (async (input: string | URL) => {
      const url = new URL(String(input));
      const file = url.pathname.endsWith("/environments")
        ? "environments.json"
        : url.pathname === "/api/v2/flags/shop"
          ? url.searchParams.get("offset")
            ? "flags-page2.json"
            : "flags-page1.json"
          : ((
              {
                "proj/shop:env/production:flag/new-checkout": "auditlog-new-checkout-production.json",
                "proj/shop:env/staging:flag/new-checkout": "auditlog-new-checkout-staging.json",
              } as Record<string, string>
            )[url.searchParams.get("spec") ?? ""] ?? "auditlog-empty.json");
      return new Response(fixture(file));
    }) as typeof globalThis.fetch;
    const ld = config();
    const source = new LaunchDarklySource(ld, { token: "t", fetch });
    const r = await source.read((f) => needsHistory(f, ld, codeNames));
    const report = evaluate(r, codeNames);
    const verdicts = Object.fromEntries(report.flags.map((f) => [f.key, [f.codeName, f.verdict]]));
    expect(verdicts).toEqual({
      "checkout-theme": [undefined, "unreferenced"],
      "express-shipping": ["ExpressShipping", "keep"],
      "new-checkout": ["NewCheckout", "remove"],
      "permanent-banner": [undefined, "unreferenced"],
      "recent-search": [undefined, "unreferenced"],
    });
    expect(report.flags.find((f) => f.key === "new-checkout")!.environments).toEqual([
      { environment: "production", serves: "fixed", value: true, since: daysAgo(45), sinceSource: "audit", days: 45 },
      { environment: "staging", serves: "fixed", value: true, since: daysAgo(50), sinceSource: "audit", days: 50 },
    ]);
  });
});

describe("evaluateStale — JSON shape", () => {
  it("carries the schema version, project, evaluation time, conditions and flags, without the token", () => {
    const report = evaluate(read(flag("new-checkout")), ["NewCheckout"]);
    expect(Object.keys(report)).toEqual(["schemaVersion", "project", "evaluatedAt", "conditions", "flags"]);
    expect(report).toMatchObject({
      schemaVersion: 8,
      project: "shop",
      evaluatedAt: "2026-10-01T00:00:00.000Z",
      conditions: { environments: ["production", "staging"], minDaysOn: 30, temporaryOnly: true },
    });
    expect(Object.keys(report.flags[0])).toEqual(["key", "codeName", "environments", "verdict", "reasons"]);
    expect(JSON.stringify(report)).not.toContain("LD_API_TOKEN");
  });
});
