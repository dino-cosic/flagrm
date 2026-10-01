import { describe, expect, it } from "vitest";
import { discoverTypeScript } from "../src/adapters/angular/discover.js";

const pick = (file: string, src: string) =>
  discoverTypeScript(src, file, "web").map((c) => ({
    flag: c.flag,
    source: c.source,
    symbol: c.symbol,
    environment: c.environment,
    state: c.state,
    line: c.line,
  }));

describe("discoverTypeScript", () => {
  it("reads flags-object keys, using each string value as the flag name", () => {
    const src = [
      "export const FLAGS = {",
      "  newCheckout: 'NewCheckout',",
      "  darkMode: 'DarkMode',",
      "  retries: 3,",
      "} as const;",
      "const labels = { newCheckout: 'New checkout' };",
    ].join("\n");
    expect(pick("/app/src/flags.ts", src)).toEqual([
      { flag: "NewCheckout", source: "object-key", symbol: "FLAGS.newCheckout", line: 2 },
      { flag: "DarkMode", source: "object-key", symbol: "FLAGS.darkMode", line: 3 },
    ]);
  });

  it("reads members of an enum named like a flag registry", () => {
    const src = [
      "export enum FeatureFlag {",
      "  NewCheckout = 'NewCheckout',",
      "  Beta = 'beta-program',",
      "  Legacy,",
      "}",
      "enum Color { Red = 'red' }",
    ].join("\n");
    expect(pick("/app/src/flags.ts", src).map((c) => [c.flag, c.symbol])).toEqual([
      ["NewCheckout", "FeatureFlag.NewCheckout"],
      ["beta-program", "FeatureFlag.Beta"],
      ["Legacy", "FeatureFlag.Legacy"],
    ]);
  });

  it("reads boolean flags from the features object of an environment file", () => {
    const src = [
      "export const environment = {",
      "  production: true,",
      "  features: {",
      "    NewCheckout: true,",
      "    'Express-Shipping': false,",
      "  } as Record<string, boolean>,",
      "};",
    ].join("\n");
    expect(pick("/app/src/environments/environment.prod.ts", src)).toEqual([
      { flag: "NewCheckout", source: "config", symbol: undefined, environment: "prod", state: "on", line: 4 },
      { flag: "Express-Shipping", source: "config", symbol: undefined, environment: "prod", state: "off", line: 5 },
    ]);
    expect(pick("/app/src/environments/environment.ts", src)[0].environment).toBe("default");
  });

  it("ignores boolean properties outside environment files and outside a features object", () => {
    expect(pick("/app/src/config.ts", "export const cfg = { features: { NewCheckout: true } };")).toEqual([]);
    expect(pick("/app/src/environments/environment.ts", "export const environment = { production: true };")).toEqual(
      [],
    );
  });
});
