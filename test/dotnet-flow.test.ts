import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { buildInventory } from "../src/core/inventory.js";
import { resolveProjects } from "../src/core/registry.js";

// The shapes from a real removal (bitwarden/server, VFO1Foundation), trimmed down.

let tmp: string;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-flow-")));
  write("flagrm.config.yaml", "projects:\n  - name: api\n    adapter: dotnet\n    path: .\n");
  write(
    "src/Core/FeatureFlagKeys.cs",
    `public static class FeatureFlagKeys
{
    public const string Vfo1Foundation = "pm-26500-vfo1-foundation";
    public const string Other = "pm-1-other";
}
`,
  );
  write(
    "src/Core/PolicyService.cs",
    `public class PolicyService
{
    private readonly IFeatureService _featureService;

    public string Describe(Policy policy)
    {
        // IsEnabled(FeatureFlagKeys.Vfo1Foundation) in a comment is not a call.
        var useVfo1Terminology = _featureService.IsEnabled(FeatureFlagKeys.Vfo1Foundation);
        var other = _featureService.IsEnabled(FeatureFlagKeys.Other);
        var label = _featureService.IsEnabled(FeatureFlagKeys.Vfo1Foundation) ? "a" : "b";
        return policy.GetName(useVfo1Terminology) + label;
    }

    public bool Check(License license, Organization org) =>
        LicenseRules.CanUseLicense(license, org, _featureService.IsEnabled(FeatureFlagKeys.Vfo1Foundation), true);
}

public class Policy
{
    public string GetName(bool useVfo1Terminology) => useVfo1Terminology ? "Require single sign-on (SSO)" : "Single sign-on";
}

public static class LicenseRules
{
    public static bool CanUseLicense(License license, Organization org, bool useSharedFolderTerminology, bool strict)
    {
        return strict;
    }
}

public static class CollectionTerminology
{
    public static string Plural(IFeatureService featureService) =>
        featureService.IsEnabled(FeatureFlagKeys.Vfo1Foundation) ? "collections" : "shared folders";

    public static bool IsVfo1On(IFeatureService featureService)
    {
        return featureService.IsEnabled(FeatureFlagKeys.Vfo1Foundation);
    }
}
`,
  );
  write(
    "test/Core.Test/PolicyTests.cs",
    `public class PolicyTests
{
    [Fact]
    public void Names()
    {
        Assert.Equal("a", new Policy().GetName(true));
        Assert.Equal("b", new Policy().GetName(useVfo1Terminology: false));
        Assert.False(LicenseRules.CanUseLicense(license, org, false, false));
        var useVfo1Terminology = featureService.IsEnabled(FeatureFlagKeys.Vfo1Foundation);
    }
}
`,
  );
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function vfo1() {
  const report = await buildInventory(resolveProjects(loadConfig({}, tmp)));
  const entry = report.flags.find((f) => f.flag === "pm-26500-vfo1-foundation");
  if (!entry) throw new Error("flag not found");
  return entry;
}

describe(".NET flow discovery", () => {
  it("records a method or property everywhere only when its name names the flag", async () => {
    write(
      "src/Core/Wrappers.cs",
      `public class Wrappers
{
    private readonly IFeatureService _fs;
    public bool IsVfo1FoundationOn() => _fs.IsEnabled(FeatureFlagKeys.Vfo1Foundation);
    public bool Foundation => _fs.IsEnabled(FeatureFlagKeys.Vfo1Foundation);
}
`,
    );
    const flow = (await vfo1()).flow;
    expect(flow.find((n) => n.name === "IsVfo1FoundationOn")?.record).toBe(true);
    expect(flow.find((n) => n.name === "Foundation")).toMatchObject({ kind: "property", record: false });
  });

  it("finds the locals, parameters and methods the flag's value travels through, outside tests", async () => {
    const entry = await vfo1();
    const flow = entry.flow.map((n) => `${n.kind} ${n.name} ${n.record ? "record" : "suggest"} :${n.line}`);
    expect(flow.sort()).toEqual(
      [
        "local useVfo1Terminology record :8",
        "method CollectionTerminology.IsVfo1On record :38",
        "method CollectionTerminology.Plural suggest :34",
        "parameter useSharedFolderTerminology suggest :25",
        "parameter useVfo1Terminology record :20",
      ].sort(),
    );
  });

  it("doesn't attribute another flag's values", async () => {
    const report = await buildInventory(resolveProjects(loadConfig({}, tmp)));
    const other = report.flags.find((f) => f.flag === "pm-1-other");
    expect(other?.flow.map((n) => n.name)).toEqual(["other"]);
    expect(other?.flow[0].record).toBe(true);
  });

  it("suggests both parameters and reports no tests when the callee could be either of two methods", async () => {
    write(
      "src/Core/Organization.cs",
      'public class Organization\n{\n    public string GetName(bool includeDomain) => includeDomain ? "a" : "b";\n}\n',
    );
    const entry = await vfo1();
    const params = entry.flow.filter((n) => n.kind === "parameter" && n.name !== "useSharedFolderTerminology");
    expect(params.map((n) => `${n.name} ${n.record} ${n.ambiguous}`).sort()).toEqual([
      "includeDomain false true",
      "useVfo1Terminology false true",
    ]);
    expect(entry.parameterizedTests.map((t) => t.method)).toEqual(["CanUseLicense"]);
  });

  it("follows only bool wrappers, by Class.Method or a name declared once", async () => {
    write(
      "src/Core/Callers.cs",
      `public class Callers
{
    public void Run(IFeatureService fs, Other other, Sso sso)
    {
        var fromStatic = CollectionTerminology.IsVfo1On(fs);
        var fromOtherClass = Other.IsVfo1On(fs);
        var noun = CollectionTerminology.Plural(fs);
        var fromInstance = sso.UsesVfo1Sso();
        var fromDuplicate = other.HasVfo1();
    }
}

public class Sso
{
    private readonly IFeatureService _fs;
    public bool UsesVfo1Sso() => _fs.IsEnabled(FeatureFlagKeys.Vfo1Foundation);
}

public class Vfo1A { public bool HasVfo1() => _fs.IsEnabled(FeatureFlagKeys.Vfo1Foundation); }
public class Vfo1B { public bool HasVfo1() => true; }
`,
    );
    const flow = (await vfo1()).flow;
    const locals = flow.filter((n) => n.kind === "local").map((n) => n.name);
    expect(locals.sort()).toEqual(["fromInstance", "fromStatic", "useVfo1Terminology"]);
    // Vfo1B.HasVfo1 has nothing to do with the flag: the name is only suggested.
    expect(flow.find((n) => n.name === "HasVfo1")).toMatchObject({ ambiguous: true, record: false });
    expect(flow.find((n) => n.name === "UsesVfo1Sso")).toMatchObject({ record: true });
  });

  it("lists test calls that pass a literal for such a parameter", async () => {
    const entry = await vfo1();
    expect(entry.parameterizedTests.map((t) => `${t.method}(${t.parameter}: ${t.value}) :${t.line}`).sort()).toEqual(
      [
        "CanUseLicense(useSharedFolderTerminology: false) :8",
        "GetName(useVfo1Terminology: false) :7",
        "GetName(useVfo1Terminology: true) :6",
      ].sort(),
    );
  });
});
