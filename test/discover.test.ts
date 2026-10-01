import { describe, expect, it } from "vitest";
import { discoverInText } from "../src/core/discover.js";

const CTX = { evalMethods: ["IsEnabled", "isEnabled"], attributes: ["FeatureGate"] };

describe("discoverInText", () => {
  it("finds top-level FeatureManagement keys in an appsettings.json file", () => {
    const src = [
      "{",
      '  "Logging": { "LogLevel": { "Default": "Information" } },',
      '  "FeatureManagement": {',
      '    "EnableNewDashboard": true,',
      '    "UseNewApi": { "EnabledFor": [{ "Name": "Percentage" }] }',
      "  }",
      "}",
    ].join("\n");
    const candidates = discoverInText(src, "appsettings.json", "backend", CTX);
    expect(candidates.map((c) => c.flag).sort()).toEqual(["EnableNewDashboard", "UseNewApi"]);
    expect(candidates.every((c) => c.source === "config" && c.environment === "default")).toBe(true);
    // Nested keys (LogLevel, Default, EnabledFor, Name) are not candidates.
    expect(candidates.some((c) => c.flag === "Default")).toBe(false);
    expect(candidates.some((c) => c.flag === "EnabledFor")).toBe(false);
  });

  it("ignores a FeatureManagement key that is commented out (JSONC)", () => {
    const src = ["{", '  "FeatureManagement": {', '    // "OldFlag": true,', '    "RealFlag": true', "  }", "}"].join(
      "\n",
    );
    const candidates = discoverInText(src, "appsettings.json", "backend", CTX);
    expect(candidates.map((c) => c.flag)).toEqual(["RealFlag"]);
  });

  it("records each FeatureManagement key's state and the environment the file configures", () => {
    const src = [
      "{",
      '  "FeatureManagement": {',
      '    "On": true,',
      '    "Off": false, // JSONC comment',
      '    "Rollout": { "EnabledFor": [{ "Name": "Percentage", "Parameters": { "Value": 50 } }] },',
      '    "Always": { "EnabledFor": [{ "Name": "AlwaysOn" }] },',
      '    "Never": { "EnabledFor": [] },',
      "  },",
      "}",
    ].join("\n");
    const candidates = discoverInText(src, "/app/appsettings.Staging.json", "backend", CTX);
    expect(candidates.map((c) => [c.flag, c.environment, c.state, c.filters])).toEqual([
      ["On", "Staging", "on", undefined],
      ["Off", "Staging", "off", undefined],
      ["Rollout", "Staging", "conditional", ["Percentage"]],
      ["Always", "Staging", "on", undefined],
      ["Never", "Staging", "off", undefined],
    ]);
  });

  it("extracts the first string-literal argument of a configured eval method call", () => {
    const src = `return _fm.IsEnabled("MyFlag", someOtherArg);`;
    const candidates = discoverInText(src, "a.cs", "backend", CTX);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ flag: "MyFlag", source: "eval", project: "backend" });
  });

  it("extracts every string-literal argument from a multi-flag attribute", () => {
    const src = `[FeatureGate("FlagA", "FlagB")]\npublic IActionResult Get() => Ok();`;
    const candidates = discoverInText(src, "a.cs", "backend", CTX);
    expect(candidates.map((c) => c.flag)).toEqual(["FlagA", "FlagB"]);
    expect(candidates.every((c) => c.source === "attribute")).toBe(true);
  });

  it("finds const string members of a *Flags-named class", () => {
    const src = [
      "public static class MyFeatureFlags",
      "{",
      '    public const string EnableNewDashboard = "EnableNewDashboard";',
      '    public const string UseNewApi = "UseNewApi";',
      "}",
    ].join("\n");
    const candidates = discoverInText(src, "MyFeatureFlags.cs", "backend", { evalMethods: [], attributes: [] });
    expect(candidates.map((c) => c.flag).sort()).toEqual(["EnableNewDashboard", "UseNewApi"]);
    expect(candidates.every((c) => c.source === "constant")).toBe(true);
    expect(candidates.map((c) => c.symbol).sort()).toEqual([
      "MyFeatureFlags.EnableNewDashboard",
      "MyFeatureFlags.UseNewApi",
    ]);
  });

  it("qualifies a const of a nested class with the whole type path and ignores locals", () => {
    const src = [
      "public static class FeatureFlags",
      "{",
      "    public static class Checkout",
      "    {",
      '        public const string New = "New";',
      "    }",
      '    public const string Top = "Top";',
      '    public static void Run() { const string local = "x"; }',
      "}",
    ].join("\n");
    const candidates = discoverInText(src, "FeatureFlags.cs", "backend", { evalMethods: [], attributes: [] });
    expect(candidates.map((c) => c.symbol).sort()).toEqual(["FeatureFlags.Checkout.New", "FeatureFlags.Top"]);
  });

  it("names a record class/struct by its own name and ignores type keywords in comments", () => {
    const src = [
      "public static class FeatureFlags",
      "{",
      "    public record class Checkout",
      "    {",
      '        public const string NewFlow = "checkout-new-flow";',
      "    }",
      '    public readonly record struct Search { public const string Fuzzy = "fuzzy"; }',
      "    // Helper class for lookups",
      '    static string Get() { const string Key = "x"; return Key; }',
      "}",
    ].join("\n");
    const candidates = discoverInText(src, "FeatureFlags.cs", "backend", { evalMethods: [], attributes: [] });
    expect(candidates.map((c) => c.symbol).sort()).toEqual([
      "FeatureFlags.Checkout.NewFlow",
      "FeatureFlags.Search.Fuzzy",
    ]);
  });

  it("ignores preprocessor lines and generic constraints when naming nested types", () => {
    const src = [
      "public static class FeatureFlags",
      "{",
      "    #region Nested class definitions",
      "    public static class Checkout",
      "    {",
      '        public const string New = "New";',
      "    }",
      "    #endregion",
      '    static void M<T, U>() where T : class where U : struct { const string Local = "x"; }',
      "}",
    ].join("\n");
    const candidates = discoverInText(src, "FeatureFlags.cs", "backend", { evalMethods: [], attributes: [] });
    expect(candidates.map((c) => c.symbol)).toEqual(["FeatureFlags.Checkout.New"]);
  });

  it("finds consts in nested interfaces and flag-named records, skipping body-less records", () => {
    const src = [
      "public static class FeatureFlags",
      "{",
      '    public interface IBilling { const string Invoices = "invoices"; }',
      '    public record CheckoutFlags { public const string New = "new"; }',
      "}",
      "public record SearchFlags(string Name);",
      'public static class Other { public const string NotAFlag = "x"; }',
    ].join("\n");
    const candidates = discoverInText(src, "FeatureFlags.cs", "backend", { evalMethods: [], attributes: [] });
    expect(candidates.map((c) => c.symbol).sort()).toEqual(["CheckoutFlags.New", "FeatureFlags.IBilling.Invoices"]);
  });

  it("does not take a parameter of a type named Record as a flag type", () => {
    const src = 'public class Store { public void Save(Record featureFlags) { const string Key = "cache-key"; } }';
    const candidates = discoverInText(src, "Store.cs", "backend", { evalMethods: [], attributes: [] });
    expect(candidates).toEqual([]);
  });

  it("uses a const's string value as the flag name and keeps its own name in the symbol", () => {
    const src = ["public static class Flags", "{", '    public const string Checkout = "new-checkout";', "}"].join(
      "\n",
    );
    const candidates = discoverInText(src, "Flags.cs", "backend", { evalMethods: [], attributes: [] });
    expect(candidates).toEqual([
      expect.objectContaining({ flag: "new-checkout", symbol: "Flags.Checkout", source: "constant", line: 3 }),
    ]);
  });

  it("finds members of an enum named Feature", () => {
    const src = ["public enum Feature", "{", "    NewCheckout,", "}"].join("\n");
    const candidates = discoverInText(src, "Feature.cs", "backend", { evalMethods: [], attributes: [] });
    expect(candidates).toEqual([expect.objectContaining({ flag: "NewCheckout", symbol: "Feature.NewCheckout" })]);
  });

  it("finds members of a *Flags-named enum, skipping attribute/comment lines", () => {
    const src = [
      "public enum MyFeatureFlags",
      "{",
      "    // legacy, remove soon",
      "    [Obsolete]",
      "    EnableNewDashboard,",
      "    UseNewApi",
      "}",
    ].join("\n");
    const candidates = discoverInText(src, "MyFeatureFlags.cs", "backend", { evalMethods: [], attributes: [] });
    expect(candidates.map((c) => c.flag).sort()).toEqual(["EnableNewDashboard", "UseNewApi"]);
  });

  it("finds single-quoted eval literals in an Angular template", () => {
    const src = `<div *ngIf="featureFlags.isEnabled('MyFlag')"></div>`;
    const candidates = discoverInText(src, "a.html", "frontend", { evalMethods: ["isEnabled"], attributes: [] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ flag: "MyFlag", source: "eval", project: "frontend" });
  });

  it("returns no candidates when nothing matches", () => {
    expect(discoverInText("nothing here", "a.cs", "backend", CTX)).toEqual([]);
  });
});
