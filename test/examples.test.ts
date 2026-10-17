import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "tinyglobby";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

// The CI examples run flagrm unattended: every `flagrm <command> --option` they
// use must exist in the CLI, as test/skills.test.ts checks for the skills.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CLI = path.join(ROOT, "dist", "cli.js");

const help = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args, "--help"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } })
    .stdout;

const commands = new Set([...(help([]).split("Commands:")[1] ?? "").matchAll(/^ {2}([a-z][\w-]*)/gm)].map((m) => m[1]));

/** Every string value in a parsed YAML document: the scripts and step settings. */
function strings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node && typeof node === "object") return Object.values(node).flatMap(strings);
  return [];
}

const files = globSync("examples/ci/*.yml", { cwd: ROOT });

describe("CI examples", () => {
  it("has a GitHub Actions and an Azure Pipelines example", () => {
    expect(files.sort()).toEqual(["examples/ci/azure-pipelines.yml", "examples/ci/github-actions.yml"]);
  });

  it.each(files)("%s parses and uses only real flagrm commands and options", (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const scripts = strings(YAML.parse(text)).join("\n");
    const problems: string[] = [];
    const used = [...scripts.matchAll(/\bnpx --no-install flagrm ([a-z][\w-]*)([^|;&\n]*)/g)];
    expect(used.length).toBeGreaterThan(0);
    for (const [, command, rest] of used) {
      if (!commands.has(command)) {
        problems.push(`unknown command: flagrm ${command}`);
        continue;
      }
      const text = help([command]);
      for (const option of rest.matchAll(/--[a-z][\w-]*/g)) {
        if (!text.includes(option[0])) problems.push(`flagrm ${command}: unknown option ${option[0]}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(files)("%s runs flagrm with npx --no-install (plain npx flagrm is another package)", (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    expect(text).toMatch(/npx --no-install flagrm stale --json/);
    expect(text).not.toMatch(/npx (?!--no-install )flagrm/);
  });

  it.each(files)("%s gates the pull request on the pipeline's own verify", (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const verify = text.indexOf('flagrm verify "$FLAG" --json');
    expect(verify).toBeGreaterThan(text.indexOf("claude -p"));
    expect(verify).toBeLessThan(text.indexOf("pr create"));
  });
});
