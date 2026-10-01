import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testFileRan } from "../src/core/verify/commands.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-ran-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const file = (rel: string, text: string) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};

describe("testFileRan", () => {
  const unit = 'Bit.Identity.Test.Auth.Controllers.AccountsControllerTests.Register(name: "x")';

  it("matches a C# test class by its namespace, not only its name", () => {
    const integration = file(
      "test/Identity.IntegrationTest/Controllers/AccountsControllerTests.cs",
      "namespace Bit.Identity.IntegrationTest.Controllers;\n\npublic class AccountsControllerTests {}\n",
    );
    const ran = file(
      "test/Identity.Test/Auth/Controllers/AccountsControllerTests.cs",
      "namespace Bit.Identity.Test.Auth.Controllers\n{\n    public class AccountsControllerTests {}\n}\n",
    );
    expect(testFileRan(integration, tmp, [unit])).toBe(false);
    expect(testFileRan(ran, tmp, [unit])).toBe(true);
  });

  it("falls back to the class name when the file declares no namespace", () => {
    const f = file("test/AccountsControllerTests.cs", "public class AccountsControllerTests {}\n");
    expect(testFileRan(f, tmp, [unit])).toBe(true);
  });

  it("matches a Java test class by its package", () => {
    const f = file("src/test/java/shop/CheckoutTest.java", "package shop.web;\n\nclass CheckoutTest {}\n");
    expect(testFileRan(f, tmp, ["shop.api.CheckoutTest › placesOrder"])).toBe(false);
    expect(testFileRan(f, tmp, ["shop.web.CheckoutTest › placesOrder"])).toBe(true);
  });
});
