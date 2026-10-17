import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LaunchDarklyConfig } from "../src/core/config.js";
import { LaunchDarklySource, parseFlag, servedValue } from "../src/core/sources/launchdarkly.js";
import { SourceError } from "../src/core/sources/types.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "launchdarkly");
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const NOW = Date.UTC(2026, 9, 1);
const TOKEN = "api-secret-token-123";

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

type Route = (url: URL) => Response | undefined;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The project from the fixtures: environments, two pages of flags, audit logs for new-checkout. */
const project: Route = (url) => {
  const p = url.pathname;
  if (p === "/api/v2/projects/shop/environments") return json(fixture("environments.json"));
  if (p === "/api/v2/flags/shop") {
    return json(fixture(url.searchParams.get("offset") === "100" ? "flags-page2.json" : "flags-page1.json"));
  }
  if (p === "/api/v2/auditlog") {
    const spec = url.searchParams.get("spec");
    if (spec === "proj/shop:env/production:flag/new-checkout")
      return json(fixture("auditlog-new-checkout-production.json"));
    if (spec === "proj/shop:env/staging:flag/new-checkout") return json(fixture("auditlog-new-checkout-staging.json"));
    return json(fixture("auditlog-empty.json"));
  }
  return undefined;
};

/** A stub `fetch` answering from `routes` in order (a route returning undefined passes), recording each call. */
function stub(...routes: Route[]) {
  const calls: Array<{ url: URL; headers: Headers }> = [];
  const sleeps: number[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    for (const route of routes) {
      const res = route(url);
      if (res) return res;
    }
    return json({ message: "not found" }, 404);
  }) as typeof globalThis.fetch;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  return { fetch, sleep, calls, sleeps };
}

const source = (s: ReturnType<typeof stub>, over: Partial<LaunchDarklyConfig> = {}) =>
  new LaunchDarklySource(config(over), { token: TOKEN, fetch: s.fetch, sleep: s.sleep, now: () => NOW });

async function sourceError(promise: Promise<unknown>): Promise<SourceError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SourceError);
  expect((err as Error).message).not.toContain(TOKEN);
  return err as SourceError;
}

describe("LaunchDarklySource — HTTP", () => {
  it("sends the token and pinned API version on every request", async () => {
    const s = stub(project);
    await source(s).read(() => false);
    expect(s.calls.length).toBeGreaterThan(0);
    for (const call of s.calls) {
      expect(call.headers.get("Authorization")).toBe(TOKEN);
      expect(call.headers.get("LD-API-Version")).toBe("20240415");
    }
  });

  it("waits for a 429's reset time, then retries", async () => {
    let limited = false;
    const s = stub((url) => {
      if (limited || url.pathname !== "/api/v2/projects/shop/environments") return undefined;
      limited = true;
      return json({}, 429, { "X-Ratelimit-Reset": String(NOW + 2000) });
    }, project);
    const read = await source(s).read(() => false);
    expect(read.environments).toEqual(["production", "staging"]);
    expect(s.sleeps).toEqual([2000]);
  });

  it("caps the wait at a minute and gives up after 5 retries", async () => {
    const s = stub(() => json({}, 429, { "Retry-After": "600" }));
    const err = await sourceError(source(s).read(() => false));
    expect(err.message).toContain("429");
    expect(s.sleeps).toEqual([60_000, 60_000, 60_000, 60_000, 60_000]);
  });

  it("says the token was rejected on 401, naming the variable", async () => {
    const s = stub(() => json({ message: `bad token ${TOKEN}` }, 401));
    const err = await sourceError(source(s).read(() => false));
    expect(err.message).toBe(
      "LaunchDarkly rejected the token in LD_API_TOKEN (401) for GET /api/v2/projects/shop/environments",
    );
  });

  it("names the project on a 404", async () => {
    const s = stub(() => json({}, 404));
    const err = await sourceError(source(s, { project: "shop" }).read(() => false));
    expect(err.message).toContain('project "shop" not found (404)');
  });

  it("reports a 5xx with the status and endpoint", async () => {
    const s = stub(() => json({}, 503));
    const err = await sourceError(source(s).read(() => false));
    expect(err.message).toBe("LaunchDarkly answered 503 for GET /api/v2/projects/shop/environments");
  });

  it("reports a network failure without the token", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED", message: `connect ${TOKEN}` } });
    }) as unknown as typeof globalThis.fetch;
    const err = await sourceError(new LaunchDarklySource(config(), { token: TOKEN, fetch }).read(() => false));
    expect(err.message).toBe("Couldn't reach LaunchDarkly (ECONNREFUSED) for GET /api/v2/projects/shop/environments");
  });

  it("reports a timeout", async () => {
    const fetch = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as typeof globalThis.fetch;
    const err = await sourceError(new LaunchDarklySource(config(), { token: TOKEN, fetch }).read(() => false));
    expect(err.message).toContain("didn't answer within 30 s");
  });
});

describe("LaunchDarklySource — environments and flags", () => {
  it("reads every page of flags with full targeting for the checked environments", async () => {
    const s = stub(project);
    const read = await source(s).read(() => false);
    expect(read.flags.map((f) => f.key)).toEqual([
      "new-checkout",
      "express-shipping",
      "permanent-banner",
      "recent-search",
      "checkout-theme",
    ]);
    const listing = s.calls.find((c) => c.url.pathname === "/api/v2/flags/shop")!.url;
    expect(listing.searchParams.get("summary")).toBe("0");
    expect(listing.searchParams.getAll("env")).toEqual(["production", "staging"]);
  });

  it("checks only the configured environments", async () => {
    const s = stub(project);
    const read = await source(s, { environments: ["production"] }).read(() => false);
    expect(read.environments).toEqual(["production"]);
    expect(Object.keys(read.flags[0].environments)).toEqual(["production"]);
  });

  it("fails as a usage error (not a SourceError) on an environment the project lacks", async () => {
    const s = stub(project);
    const err = await source(s, { environments: ["production", "prod-eu"] })
      .read(() => false)
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SourceError);
    expect((err as Error).message).toBe(
      'launchdarkly.environments: "prod-eu" not in LaunchDarkly project "shop". Its environments: production, staging.',
    );
  });

  it("asks for at most three environments per listing and merges them", async () => {
    const envs = ["a", "b", "c", "d"];
    const s = stub((url) => {
      if (url.pathname === "/api/v2/projects/shop/environments") return json({ items: envs.map((key) => ({ key })) });
      if (url.pathname !== "/api/v2/flags/shop") return undefined;
      const asked = url.searchParams.getAll("env");
      const flag = fixture("flags-page1.json").items[0];
      flag.environments = Object.fromEntries(asked.map((e) => [e, flag.environments.production]));
      return json({ items: [flag] });
    });
    const read = await source(s).read(() => false);
    const listings = s.calls.filter((c) => c.url.pathname === "/api/v2/flags/shop");
    expect(listings.map((c) => c.url.searchParams.getAll("env"))).toEqual([["a", "b", "c"], ["d"]]);
    expect(Object.keys(read.flags[0].environments)).toEqual(envs);
  });
});

describe("LaunchDarklySource — archived flags and links", () => {
  it("leaves archived flags to LaunchDarkly's default: no archived filter is asked for", async () => {
    const s = stub(project);
    await source(s).read(() => false);
    for (const call of s.calls.filter((c) => c.url.pathname === "/api/v2/flags/shop")) {
      expect(call.url.searchParams.has("archived")).toBe(false);
      expect(call.url.searchParams.get("filter") ?? "").not.toContain("archived");
    }
  });

  it("follows an absolute next link on the same origin", async () => {
    const s = stub((url) => {
      if (url.pathname !== "/api/v2/flags/shop" || url.searchParams.get("offset")) return undefined;
      const page = fixture("flags-page1.json");
      page._links.next.href = `https://ld.test${page._links.next.href}`;
      return json(page);
    }, project);
    const read = await source(s).read(() => false);
    expect(read.flags).toHaveLength(5);
  });

  it("refuses a next link to another host, so the token stays with baseUrl", async () => {
    const s = stub((url) => {
      if (url.pathname !== "/api/v2/flags/shop") return undefined;
      const page = fixture("flags-page1.json");
      page._links.next.href = "https://evil.test/api/v2/flags/shop?offset=100";
      return json(page);
    }, project);
    const err = await sourceError(source(s).read(() => false));
    expect(err.message).toContain("another host (https://evil.test)");
    expect(s.calls.some((c) => c.url.host === "evil.test")).toBe(false);
  });

  it("says project not found only for the project's endpoints", async () => {
    const s = stub((url) => (url.pathname === "/api/v2/auditlog" ? json({}, 404) : undefined), project);
    const err = await sourceError(source(s).read((f) => f.key === "new-checkout"));
    expect(err.message).toBe("LaunchDarkly found nothing (404) at GET /api/v2/auditlog");
  });
});

describe("servedValue", () => {
  const BOOL = [{ value: true }, { value: false }];
  const env = (over: Record<string, unknown> = {}) => ({
    on: true,
    targets: [],
    contextTargets: [],
    rules: [],
    prerequisites: [],
    fallthrough: { variation: 0 },
    offVariation: 1,
    ...over,
  });

  it("targeting on, fallthrough true, no rules: fixed true", () => {
    expect(servedValue(env(), BOOL)).toEqual({ kind: "fixed", value: true });
  });

  it("targeting off: the off variation", () => {
    expect(servedValue(env({ on: false }), BOOL)).toEqual({ kind: "fixed", value: false });
  });

  it("targeting off without an off variation: targeted (the code's fallback)", () => {
    expect(servedValue(env({ on: false, offVariation: null }), BOOL)?.kind).toBe("targeted");
  });

  it("a percentage rollout: targeted", () => {
    const rollout = { variations: [{ variation: 0, weight: 100000 }] };
    expect(servedValue(env({ fallthrough: { rollout } }), BOOL)).toEqual({
      kind: "targeted",
      detail: "a percentage rollout",
    });
  });

  it.each([
    ["rules", { rules: [{ variation: 0, clauses: [] }] }],
    ["targets", { targets: [{ values: ["u1"], variation: 0 }] }],
    ["contextTargets", { contextTargets: [{ values: ["o1"], variation: 0, contextKind: "org" }] }],
    ["prerequisites", { prerequisites: [{ key: "other", variation: 0 }] }],
  ])("%s with targeting on: targeted", (_, over) => {
    expect(servedValue(env(over), BOOL)?.kind).toBe("targeted");
  });

  it("unreadable data: undefined", () => {
    expect(servedValue(env({ on: "yes" }), BOOL)).toBeUndefined();
    expect(servedValue(env({ rules: {} }), BOOL)).toBeUndefined();
    expect(servedValue(env({ fallthrough: { variation: 7 } }), BOOL)).toBeUndefined();
  });
});

describe("LaunchDarklySource — since", () => {
  it("dates since from the last targeting change; a later description edit doesn't reset it", async () => {
    const read = await source(stub(project)).read((f) => f.key === "new-checkout");
    const flag = read.flags.find((f) => f.key === "new-checkout")!;
    expect(flag.environments.production).toMatchObject({
      since: new Date(NOW - 45 * 86_400_000).toISOString(),
      sinceSource: "audit",
    });
    expect(flag.environments.staging).toMatchObject({
      since: new Date(NOW - 50 * 86_400_000).toISOString(),
      sinceSource: "audit",
    });
  });

  it("falls back to lastModified when the log has no targeting entry", async () => {
    const read = await source(stub(project)).read((f) => f.key === "recent-search");
    expect(read.flags.find((f) => f.key === "recent-search")!.environments.production).toMatchObject({
      since: new Date(NOW - 10 * 86_400_000).toISOString(),
      sinceSource: "lastModified",
    });
  });

  it("counts an unknown audit action as a targeting change", async () => {
    const s = stub((url) => {
      if (url.pathname !== "/api/v2/auditlog") return undefined;
      const log = fixture("auditlog-new-checkout-production.json");
      log.items[1].accesses[0].action = "updateSomethingNew";
      return json(log);
    }, project);
    const read = await source(s).read((f) => f.key === "new-checkout");
    expect(read.flags[0].environments.production.since).toBe(new Date(NOW - 3 * 86_400_000).toISOString());
  });

  it("pages back with before, at most 5 pages, then falls back", async () => {
    const s = stub((url) => {
      if (url.pathname !== "/api/v2/auditlog") return undefined;
      const before = Number(url.searchParams.get("before") ?? NOW);
      const items = Array.from({ length: 20 }, (_, i) => ({
        date: before - (i + 1) * 1000,
        accesses: [{ action: "updateName" }],
      }));
      return json({ items });
    }, project);
    const read = await source(s, { environments: ["production"] }).read((f) => f.key === "new-checkout");
    const audits = s.calls.filter((c) => c.url.pathname === "/api/v2/auditlog");
    expect(audits).toHaveLength(5);
    expect(audits[1].url.searchParams.get("before")).toBe(String(NOW - 20_000));
    expect(read.flags[0].environments.production.sinceSource).toBe("lastModified");
  });

  it("makes no audit-log request for a flag that isn't a candidate", async () => {
    const s = stub(project);
    const read = await source(s).read(() => false);
    expect(s.calls.filter((c) => c.url.pathname === "/api/v2/auditlog")).toHaveLength(0);
    expect(read.flags[0].environments.production.sinceSource).toBe("lastModified");
  });
});

describe("parseFlag — defensive parsing", () => {
  it("marks a malformed flag as unrecognized instead of throwing", () => {
    const item = fixture("flags-malformed.json").items[0];
    const flag = parseFlag(item, item.environments, ["production", "staging"]);
    expect(flag.unrecognized).toBe(
      'unrecognized LaunchDarkly data: no temporary marker, unreadable targeting in "production"',
    );
  });

  it("marks a flag without targeting for a checked environment as unrecognized", () => {
    const item = fixture("flags-page1.json").items[0];
    expect(parseFlag(item, item.environments, ["production", "qa"]).unrecognized).toContain(
      'no targeting for environment "qa"',
    );
  });
});
