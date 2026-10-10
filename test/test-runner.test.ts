import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectTestRunner, runnerTestCommands, testResultsHint } from "../src/core/test-runner.js";

let tmp: string;
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};
const angular = (builder: string, options: Record<string, unknown> = {}) =>
  write("angular.json", JSON.stringify({ projects: { app: { architect: { test: { builder, options } } } } }));

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-runner-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("detectTestRunner", () => {
  it("reads the Angular test builder", () => {
    angular("@angular/build:unit-test");
    expect(detectTestRunner(tmp)).toEqual({ kind: "vitest-ng" });
    angular("@angular/build:unit-test", { runner: "karma" });
    expect(detectTestRunner(tmp)).toEqual({ kind: "karma" });
    angular("@angular-builders/jest:run");
    expect(detectTestRunner(tmp)).toEqual({ kind: "jest", viaNg: true });
    angular("@angular-devkit/build-angular:karma");
    expect(detectTestRunner(tmp)).toEqual({ kind: "karma" });
  });

  it("reads `targets` as well as `architect`", () => {
    write(
      "angular.json",
      JSON.stringify({ projects: { app: { targets: { test: { builder: "@angular/build:unit-test" } } } } }),
    );
    expect(detectTestRunner(tmp)).toEqual({ kind: "vitest-ng" });
  });

  it("finds Jest and Vitest from their config files", () => {
    write("angular.json", "{}");
    write("jest.config.ts", "");
    expect(detectTestRunner(tmp)).toEqual({ kind: "jest", viaNg: false });
    fs.rmSync(path.join(tmp, "jest.config.ts"));
    write("vitest.config.ts", "");
    expect(detectTestRunner(tmp)).toEqual({ kind: "vitest" });
  });

  it("sees Karma's JUnit reporter only with the plugin and a literal outputDir", () => {
    angular("@angular-devkit/build-angular:karma");
    const conf = (body: string) => write("karma.conf.js", `module.exports = (config) => config.set({ ${body} });`);
    conf("plugins: [require('karma-jasmine')], junitReporter: { outputDir: 'test-results' }");
    expect(detectTestRunner(tmp)).toEqual({ kind: "karma" });
    conf("plugins: [require('karma-junit-reporter')], junitReporter: { outputDir: dir }");
    expect(detectTestRunner(tmp)).toEqual({ kind: "karma" });
    conf(
      "plugins: [require('karma-junit-reporter')], junitReporter: { useBrowserName: false, outputDir: 'test-results' }",
    );
    expect(detectTestRunner(tmp)).toEqual({ kind: "karma", junit: { outputDir: path.join(tmp, "test-results") } });
  });

  it("follows the builder's karmaConfig option", () => {
    angular("@angular/build:karma", { karmaConfig: "config/karma.conf.js" });
    write("config/karma.conf.js", "plugins: [require('karma-junit-reporter')], junitReporter: { outputDir: '../out' }");
    expect(detectTestRunner(tmp)).toEqual({ kind: "karma", junit: { outputDir: path.join(tmp, "out") } });
  });

  it("is unknown without anything to go on, or with an angular.json that isn't JSON", () => {
    expect(detectTestRunner(tmp)).toEqual({ kind: "unknown" });
    write("angular.json", "{ nope");
    expect(detectTestRunner(tmp)).toEqual({ kind: "unknown" });
  });
});

describe("runnerTestCommands", () => {
  const dir = () => path.join(tmp, ".flagrm", "test-results", "web");
  const root = () => path.join(tmp, "web");

  it("writes results under the results directory, relative to the project in the command", () => {
    expect(runnerTestCommands({ kind: "vitest-ng" }, root(), dir())).toEqual({
      test: 'npx ng test --watch=false --reporters=junit --output-file="../.flagrm/test-results/web/junit.xml"',
      testResults: path.join(dir(), "junit.xml"),
    });
    expect(runnerTestCommands({ kind: "jest", viaNg: false }, root(), dir())).toEqual({
      test: 'npx jest --ci --json --outputFile="../.flagrm/test-results/web/jest.json"',
      testResults: path.join(dir(), "jest.json"),
    });
    expect(runnerTestCommands({ kind: "vitest" }, root(), dir())).toEqual({
      test: 'npx vitest run --reporter=default --reporter=junit --outputFile.junit="../.flagrm/test-results/web/junit.xml"',
      testResults: path.join(dir(), "junit.xml"),
    });
    expect(
      runnerTestCommands({ kind: "karma", junit: { outputDir: path.join(root(), "out") } }, root(), dir()),
    ).toEqual({
      test: "npx ng test --watch=false --reporters=progress --reporters=junit",
      testResults: path.join(root(), "out", "**", "*.xml"),
    });
  });

  it("is undefined when the runner needs setup first", () => {
    expect(runnerTestCommands({ kind: "karma" }, root(), dir())).toBeUndefined();
    expect(runnerTestCommands({ kind: "jest", viaNg: true }, root(), dir())).toBeUndefined();
    expect(runnerTestCommands({ kind: "unknown" }, root(), dir())).toBeUndefined();
  });
});

describe("testResultsHint", () => {
  it("says what to change for each runner", () => {
    const hint = (runner: Parameters<typeof testResultsHint>[0]) =>
      testResultsHint(runner, "../.flagrm/r", "./.flagrm/r", true);
    expect(hint({ kind: "karma" })).toContain("npm i -D karma-junit-reporter");
    expect(hint({ kind: "vitest-ng" })).toBe(
      'add `--reporters=junit --output-file="../.flagrm/r/junit.xml"` to the test command and set testResults: ./.flagrm/r/junit.xml (or remove `test` to use the adapter default)',
    );
    expect(hint({ kind: "jest", viaNg: false })).toContain("--json --outputFile=");
    expect(hint({ kind: "jest", viaNg: true })).toContain("@angular-builders/jest");
    expect(testResultsHint({ kind: "vitest" }, "r", "./r", false)).toBe(
      'add `--reporter=default --reporter=junit --outputFile.junit="r/junit.xml"` to the test command and set testResults: ./r/junit.xml',
    );
    expect(hint({ kind: "unknown" })).toBe(
      "make the test runner write JUnit XML, TRX or Jest JSON and point testResults at the file",
    );
  });
});
