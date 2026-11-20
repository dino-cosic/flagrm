import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitList, writeJsonFile } from "../src/core/util.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-util-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeJsonFile", () => {
  it("creates the directory, replaces the file and leaves no temporary file behind", () => {
    const file = path.join(tmp, "a", "b.json");
    writeJsonFile(file, { one: 1 });
    writeJsonFile(file, { two: 2 });
    expect(fs.readFileSync(file, "utf8")).toBe('{\n  "two": 2\n}\n');
    expect(fs.readdirSync(path.dirname(file))).toEqual(["b.json"]);
  });

  it("leaves the old file intact when the value can't be serialized", () => {
    const file = path.join(tmp, "b.json");
    writeJsonFile(file, { one: 1 });
    expect(() => writeJsonFile(file, { big: 1n })).toThrow();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ one: 1 });
    expect(fs.readdirSync(tmp)).toEqual(["b.json"]);
  });
});

describe("splitList", () => {
  it("trims items and drops empty ones", () => {
    expect(splitList(" build, tests ,,")).toEqual(["build", "tests"]);
    expect(splitList("")).toEqual([]);
  });
});
