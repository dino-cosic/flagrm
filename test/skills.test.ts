import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { describe, expect, it } from "vitest";

// Every `flagrm <command> --option` a skill tells the agent to run must exist in
// the CLI. The skills went stale once (inspect, fold, report); this keeps them honest.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CLI = path.join(ROOT, "dist", "cli.js");

const helpCache = new Map<string, string>();
function help(args: string[]): string {
  const key = args.join(" ");
  if (!helpCache.has(key)) {
    const r = spawnSync(process.execPath, [CLI, ...args, "--help"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    helpCache.set(key, r.stdout);
  }
  return helpCache.get(key) ?? "";
}

const commands = new Set([...(help([]).split("Commands:")[1] ?? "").matchAll(/^ {2}([a-z][\w-]*)/gm)].map((m) => m[1]));

/** Code in a markdown file: every line of fenced blocks, and each inline code span. */
function codeIn(markdown: string): string[] {
  const code: string[] = [];
  for (const m of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) code.push(...m[1].split("\n"));
  for (const m of markdown.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)) code.push(m[1]);
  return code;
}

const files = fg.sync("skills/**/*.md", { cwd: ROOT });

describe("skills reference only real flagrm commands and options", () => {
  it("finds the skill files and the CLI commands", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(commands).toContain("verify");
  });

  it.each(files)("%s", (file) => {
    const problems: string[] = [];
    for (const code of codeIn(fs.readFileSync(path.join(ROOT, file), "utf8"))) {
      for (const m of code.matchAll(/\bflagrm ([a-z][\w-]*)(?: ([a-z][\w-]*))?([^|;&]*)/g)) {
        const [, command, sub, rest] = m;
        if (!commands.has(command)) {
          problems.push(`unknown command: flagrm ${command}`);
          continue;
        }
        const args = command === "hook" && sub ? [command, sub] : [command];
        const text = help(args);
        for (const option of rest.matchAll(/--[a-z][\w-]*/g)) {
          if (!text.includes(option[0])) problems.push(`flagrm ${args.join(" ")}: unknown option ${option[0]}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps the skills short", () => {
    const lines = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8").split("\n").length;
    expect(lines("skills/flagrm-remove/SKILL.md")).toBeLessThan(110);
    expect(lines("skills/flagrm-verify/SKILL.md")).toBeLessThan(60);
  });

  it("gives both skills the same commit message rules", () => {
    const block = (f: string) =>
      /<!-- commit-message:start -->([\s\S]*?)<!-- commit-message:end -->/.exec(
        fs.readFileSync(path.join(ROOT, f), "utf8"),
      )?.[1];
    const remove = block("skills/flagrm-remove/SKILL.md");
    expect(remove).toBeDefined();
    expect(block("skills/flagrm-verify/SKILL.md")).toBe(remove);
  });

  it("links batch.md from the remove skill, and keeps it short", () => {
    const skill = fs.readFileSync(path.join(ROOT, "skills/flagrm-remove/SKILL.md"), "utf8");
    expect(skill).toContain("[batch.md](batch.md)");
    const batch = fs.readFileSync(path.join(ROOT, "skills/flagrm-remove/batch.md"), "utf8");
    expect(batch.split("\n").length).toBeLessThan(40);
  });

  it("keeps each skill self-contained: no references into the other skill's directory", () => {
    const problems: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      const own = file.split("/")[1];
      for (const other of ["flagrm-remove", "flagrm-verify"].filter((s) => s !== own)) {
        if (text.includes(`${other}/`)) problems.push(`${file} references ${other}/`);
      }
    }
    expect(problems).toEqual([]);
  });
});
