/**
 * Which JavaScript test runner a project uses, read from `angular.json`'s
 * test builder, config files and `package.json`, so the Angular adapter can
 * default to a test command that writes machine-readable results, and
 * doctor can say how to get them. Reads only; anything unreadable is `unknown`.
 */

import fs from "node:fs";
import path from "node:path";
import { globSync } from "tinyglobby";
import { readJson, relativePath } from "./util.js";

export type TestRunner =
  | { kind: "vitest-ng" }
  | { kind: "jest"; viaNg: boolean }
  | { kind: "vitest" }
  /** `junit`: karma.conf loads karma-junit-reporter and names a literal `outputDir` (absolute here). */
  | { kind: "karma"; junit?: { outputDir: string } }
  | { kind: "unknown" };

interface Target {
  builder?: string;
  options?: Record<string, unknown>;
}

type Targets = Record<string, Target>;

/** The test target of the first `angular.json` project that has one. */
function angularTestTarget(root: string): Target | undefined {
  const json = readJson<{ projects?: Record<string, { architect?: Targets; targets?: Targets }> }>(
    path.join(root, "angular.json"),
  );
  for (const project of Object.values(json?.projects ?? {})) {
    const test = (project?.architect ?? project?.targets)?.test;
    if (test?.builder) return test;
  }
  return undefined;
}

function dependencies(root: string): Set<string> {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    path.join(root, "package.json"),
  );
  return new Set([...Object.keys(pkg?.dependencies ?? {}), ...Object.keys(pkg?.devDependencies ?? {})]);
}

const hasFile = (root: string, pattern: string) =>
  globSync(pattern, { expandDirectories: false, cwd: root, deep: 1 }).length > 0;

function karma(root: string, options: Record<string, unknown>): TestRunner {
  const conf = path.resolve(root, typeof options.karmaConfig === "string" ? options.karmaConfig : "karma.conf.js");
  let text: string;
  try {
    text = fs.readFileSync(conf, "utf8");
  } catch {
    return { kind: "karma" };
  }
  const outputDir = /junitReporter\s*:\s*\{[^}]*?\boutputDir\s*:\s*(['"`])([^'"`]+)\1/.exec(text)?.[2];
  // Without a `plugins` key Karma loads every installed karma-* package.
  const loaded =
    text.includes("karma-junit-reporter") ||
    (!/\bplugins\s*:/.test(text) && dependencies(root).has("karma-junit-reporter"));
  return loaded && outputDir
    ? { kind: "karma", junit: { outputDir: path.resolve(path.dirname(conf), outputDir) } }
    : { kind: "karma" };
}

export function detectTestRunner(root: string): TestRunner {
  const target = angularTestTarget(root);
  const builder = target?.builder ?? "";
  const options = target?.options ?? {};
  if (builder === "@angular/build:unit-test")
    return options.runner === "karma" ? karma(root, options) : { kind: "vitest-ng" };
  if (builder.endsWith(":karma")) return karma(root, options);
  if (builder.startsWith("@angular-builders/jest")) return { kind: "jest", viaNg: true };
  if (hasFile(root, "jest.config.{js,ts,mjs,cjs,json}")) return { kind: "jest", viaNg: false };
  if (hasFile(root, "vitest.config.{js,ts,mjs,cjs,mts}")) return { kind: "vitest" };
  const deps = dependencies(root);
  if (deps.has("jest")) return { kind: "jest", viaNg: false };
  if (deps.has("vitest")) return { kind: "vitest" };
  if (hasFile(root, "karma.conf.{js,cjs,ts}")) return karma(root, {});
  return { kind: "unknown" };
}

export interface RunnerCommands {
  /** Runs in the project directory. */
  test: string;
  /** Absolute path or glob of the results `test` writes. */
  testResults: string;
}

/** The flags that make each runner write results to `file` (quoted, relative to the project). */
function resultFlags(runner: TestRunner, file: (name: string) => string): string | undefined {
  switch (runner.kind) {
    case "vitest-ng":
      // The unit-test builder's --output-file applies to the first reporter only.
      return `--reporters=junit --output-file="${file("junit.xml")}"`;
    case "jest":
      return runner.viaNg ? undefined : `--json --outputFile="${file("jest.json")}"`;
    case "vitest":
      return `--reporter=default --reporter=junit --outputFile.junit="${file("junit.xml")}"`;
    default:
      return undefined;
  }
}

const RESULT_FILE: Partial<Record<TestRunner["kind"], string>> = {
  "vitest-ng": "junit.xml",
  jest: "jest.json",
  vitest: "junit.xml",
};

/**
 * A test command for the runner that writes results into `resultsDir`, and
 * where to read them. Undefined when the runner can't without a setup change
 * (Karma without a JUnit reporter, Jest through an Angular builder, unknown).
 */
export function runnerTestCommands(
  runner: TestRunner,
  projectRoot: string,
  resultsDir: string,
): RunnerCommands | undefined {
  if (runner.kind === "karma") {
    return runner.junit
      ? {
          test: "npx ng test --watch=false --reporters=progress --reporters=junit",
          testResults: path.join(runner.junit.outputDir, "**", "*.xml"),
        }
      : undefined;
  }
  const flags = resultFlags(runner, (name) => relativePath(projectRoot, path.join(resultsDir, name)));
  const name = RESULT_FILE[runner.kind];
  if (!flags || !name) return undefined;
  const base =
    runner.kind === "vitest-ng"
      ? "npx ng test --watch=false"
      : runner.kind === "jest"
        ? "npx jest --ci"
        : "npx vitest run";
  return { test: `${base} ${flags}`, testResults: path.join(resultsDir, name) };
}

/**
 * How to get test results for a project whose test command has none: one
 * line for doctor and init. `dirFromProject` is a results directory relative
 * to the project (for the command), `dirFromConfig` the same relative to the
 * config file (for `testResults`). `adapterDefault`: the adapter's default
 * test command writes results for this runner (Angular), so removing `test` is a fix too.
 * `configRoot`: the config file's directory, for a results directory karma.conf.js names.
 */
export function testResultsHint(
  runner: TestRunner,
  dirFromProject: string,
  dirFromConfig: string,
  adapterDefault: boolean,
  configRoot: string,
): string {
  const flags = resultFlags(runner, (name) => `${dirFromProject}/${name}`);
  const name = RESULT_FILE[runner.kind];
  const fallback = adapterDefault ? " (or remove `test` to use the adapter default)" : "";
  if (flags && name) {
    return `add \`${flags}\` to the test command and set testResults: ${dirFromConfig}/${name}${fallback}`;
  }
  if (runner.kind === "karma" && runner.junit) {
    const results = `./${relativePath(configRoot, runner.junit.outputDir)}/**/*.xml`;
    return `add \`--reporters=progress --reporters=junit\` to the test command and set testResults: ${results}${fallback}`;
  }
  if (runner.kind === "karma") {
    return "npm i -D karma-junit-reporter, add require('karma-junit-reporter') to plugins and junitReporter: { outputDir: 'test-results' } to karma.conf.js; the angular adapter's default test command then writes JUnit";
  }
  if (runner.kind === "jest") {
    return `add \`--json --outputFile="${dirFromProject}/jest.json"\` to the test command if @angular-builders/jest passes them on, and set testResults: ${dirFromConfig}/jest.json`;
  }
  return "make the test runner write JUnit XML, TRX or Jest JSON and point testResults at the file";
}
