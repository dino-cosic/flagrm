import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findIdentifiers } from "../src/core/mentions.js";
import { projectContext } from "./support/projects.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-ident-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("findIdentifiers", () => {
  it("finds whole-word uses including calls, marks comments and skips strings", () => {
    fs.writeFileSync(
      path.join(tmp, "a.ts"),
      ["if (await x.IsOn()) run(); // IsOn is the wrapper", 'const s = "IsOn";', "IsOnly();", "const f = IsOn;"].join(
        "\n",
      ),
    );
    const ctx = projectContext("generic", tmp, { globs: ["**/*.ts"] });
    const hits = findIdentifiers([ctx], ["IsOn"]).map((h) => `${h.line}:${h.inComment ? "comment" : "code"}`);
    expect(hits).toEqual(["1:code", "1:comment", "4:code"]);
  });

  it("marks a bare name as a config key only in key/value config files", () => {
    fs.writeFileSync(path.join(tmp, "flags.yaml"), "flags:\n  new-checkout: true\nnote: new-checkout is on\n");
    fs.writeFileSync(path.join(tmp, "a.ts"), "const new_checkout = 1; // new-checkout\n");
    const ctx = projectContext("generic", tmp, { globs: ["**/*.yaml", "**/*.ts"] });
    const hits = findIdentifiers([ctx], ["new-checkout"]).map(
      (h) => `${path.basename(h.file)}:${h.line}:${h.isConfigKey}`,
    );
    expect(hits).toEqual(["a.ts:1:false", "flags.yaml:2:true", "flags.yaml:3:false"]);
  });

  it("marks only a whole key followed by `: ` or `=` as a config key", () => {
    fs.writeFileSync(
      path.join(tmp, "compose.yml"),
      [
        "url: http://new-checkout:8080",
        "enable-new-checkout: true",
        "features.new-checkout: true",
        "- new-checkout=on",
        "new-checkout:",
        "  x: 1",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(tmp, "app.cfg"), "new-checkout = true\n");
    const ctx = projectContext("generic", tmp, { globs: ["**/*.yml", "**/*.cfg"] });
    const hits = findIdentifiers([ctx], ["new-checkout"]).map(
      (h) => `${path.basename(h.file)}:${h.line}:${h.isConfigKey}`,
    );
    expect(hits).toEqual([
      "app.cfg:1:true",
      "compose.yml:1:false",
      "compose.yml:2:false",
      "compose.yml:3:true",
      "compose.yml:4:true",
      "compose.yml:5:true",
    ]);
  });

  it("matches environment-variable config paths in strings, json and before a deeper section", () => {
    fs.writeFileSync(
      path.join(tmp, "docker-compose.yml"),
      '    environment:\n      - "FeatureManagement__NewCheckout=true"\n      - FeatureManagement__NewCheckout__EnabledFor__0__Name=x\n      - FeatureManagement__NewCheckoutV2=true\n',
    );
    fs.writeFileSync(path.join(tmp, "launchSettings.json"), '{ "FeatureManagement__NewCheckout": "true" }\n');
    const ctx = projectContext("generic", tmp, { globs: ["**/*.yml", "**/*.json"] });
    const hits = findIdentifiers([ctx], [], ["FeatureManagement__NewCheckout"]).map(
      (h) => `${path.basename(h.file)}:${h.line}`,
    );
    expect(hits.sort()).toEqual(["docker-compose.yml:2", "docker-compose.yml:3", "launchSettings.json:1"]);
  });

  it("matches config paths in any case, together with identifiers in one pass", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "FEATUREMANAGEMENT__NEWCHECKOUT=true\n");
    fs.writeFileSync(path.join(tmp, "appsettings.json"), '{ "IsOn": true, "FeatureManagement__NewCheckout": true }\n');
    fs.writeFileSync(path.join(tmp, "a.ts"), "IsOn();\n");
    const ctx = projectContext("generic", tmp, { globs: ["**/.env", "**/*.json", "**/*.ts"] });
    const hits = findIdentifiers([ctx], ["IsOn"], ["FeatureManagement__NewCheckout"]).map(
      (h) => `${path.basename(h.file)}:${h.token}`,
    );
    expect(hits.sort()).toEqual([".env:FEATUREMANAGEMENT__NEWCHECKOUT", "a.ts:IsOn"]);
  });

  it("returns nothing for no names", () => {
    const ctx = projectContext("generic", tmp, { globs: ["**/*.ts"] });
    expect(findIdentifiers([ctx], [])).toEqual([]);
  });
});
