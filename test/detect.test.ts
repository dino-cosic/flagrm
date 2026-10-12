import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectProjects } from "../src/core/detect.js";

describe("detectProjects", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-detect-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("looks for markers at most three directories deep", () => {
    for (const dir of ["a/b/c", "w/x/y/z"]) {
      fs.mkdirSync(path.join(tmp, dir), { recursive: true });
      fs.writeFileSync(path.join(tmp, dir, "angular.json"), "{}");
    }
    expect(detectProjects(tmp).map((p) => p.marker)).toEqual(["a/b/c/angular.json"]);
  });
});
