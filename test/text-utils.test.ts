import { describe, expect, it } from "vitest";
import { toLf } from "../src/core/text-utils.js";

describe("toLf", () => {
  it("strips carriage returns before newlines", () => {
    expect(toLf("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("is a no-op for LF text", () => {
    expect(toLf("a\nb\n")).toBe("a\nb\n");
  });
});
