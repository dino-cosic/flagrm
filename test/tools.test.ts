import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { runDoctor } from "../src/core/doctor.js";
import { initProject, PROMPT_FILES, updateProject } from "../src/core/install.js";
import { askTools, detectTools, savedTools } from "../src/core/tools.js";

let tmp: string;
const read = (rel: string) => fs.readFileSync(path.join(tmp, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(tmp, rel));
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-tools-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("initProject with tools", () => {
  it("installs only Claude Code's files and saves the choice", () => {
    initProject(tmp, ["claude-code"]);
    expect(exists(".claude/skills/flagrm-remove/SKILL.md")).toBe(true);
    expect(exists(".claude/settings.json")).toBe(true);
    for (const rel of [".github", ".agents", "AGENTS.md"]) expect(exists(rel)).toBe(false);
    expect(read("flagrm.config.yaml")).toContain("tools: [claude-code]\nprojects:");
    expect(savedTools(tmp)).toEqual(["claude-code"]);
    // The template's example projects, so the config loads.
    for (const dir of ["frontend", "backend"]) fs.mkdirSync(path.join(tmp, dir));
    expect(loadConfig({}, tmp).tools).toEqual(["claude-code"]);
  });

  it("installs Copilot's skills and the /flagrm-* prompt files that point at them", () => {
    initProject(tmp, ["copilot"]);
    expect(exists(".github/skills/flagrm-verify/SKILL.md")).toBe(true);
    expect(read(".github/prompts/flagrm-remove.prompt.md")).toBe(PROMPT_FILES["flagrm-remove"]);
    expect(read(".github/prompts/flagrm-remove.prompt.md")).toContain("`.github/skills/flagrm-remove/SKILL.md`");
    for (const rel of [".claude", ".agents", "AGENTS.md"]) expect(exists(rel)).toBe(false);
  });

  it("installs Codex's skills and the AGENTS.md block", () => {
    initProject(tmp, ["codex"]);
    expect(exists(".agents/skills/flagrm-remove/SKILL.md")).toBe(true);
    expect(read("AGENTS.md")).toContain("flagrm:start");
    for (const rel of [".claude", ".github"]) expect(exists(rel)).toBe(false);
  });

  it("adds a newly chosen tool and saves it, and leaves a dropped tool's files with a note", () => {
    initProject(tmp, ["claude-code", "codex"]);
    write("flagrm.config.yaml", read("flagrm.config.yaml").replace("projects:", "# keep me\nprojects:"));
    const steps = initProject(tmp, ["copilot", "codex"]);
    expect(savedTools(tmp)).toEqual(["copilot", "codex"]);
    expect(read("flagrm.config.yaml")).toContain("# keep me");
    expect(steps.find((s) => s.path === "flagrm.config.yaml" && s.status === "updated")).toBeDefined();
    expect(exists(".github/prompts/flagrm-verify.prompt.md")).toBe(true);
    // Nothing deleted: Claude Code's files are only named.
    expect(exists(".claude/skills/flagrm-remove")).toBe(true);
    const dropped = steps.filter((s) => s.note?.includes("claude-code isn't in tools")).map((s) => s.path);
    expect(dropped).toEqual([".claude/skills/flagrm-remove", ".claude/skills/flagrm-verify", ".claude/settings.json"]);
  });
});

describe("updateProject with tools", () => {
  it("refreshes only the listed tools' files", () => {
    initProject(tmp);
    const stale = "---\nname: x\n---\nSTALE COPY\n";
    write(".claude/skills/flagrm-remove/SKILL.md", stale);
    write(".agents/skills/flagrm-remove/SKILL.md", stale);
    const steps = updateProject(tmp, ["codex"]);
    expect(read(".agents/skills/flagrm-remove/SKILL.md")).not.toContain("STALE COPY");
    expect(read(".claude/skills/flagrm-remove/SKILL.md")).toBe(stale);
    expect(steps.some((s) => s.path.startsWith(".github/prompts") && s.status !== "skipped")).toBe(false);
  });
});

describe("detectTools", () => {
  it("pre-selects the tools a repository already uses", () => {
    expect(detectTools(tmp)).toEqual([]);
    write(".claude/settings.json", "{}");
    write(".github/copilot-instructions.md", "# x");
    expect(detectTools(tmp)).toEqual(["claude-code", "copilot"]);
    write("AGENTS.md", "# x");
    expect(detectTools(tmp)).toEqual(["claude-code", "copilot", "codex"]);
  });
});

describe("savedTools", () => {
  it("rejects an unknown tool", () => {
    write("flagrm.config.yaml", "tools: [claude-code, cursor]\nprojects: []\n");
    expect(() => savedTools(tmp)).toThrow('"cursor" is not one of claude-code, copilot, codex');
  });
});

describe("askTools", () => {
  const ask = async (answers: string[], preselected: Parameters<typeof askTools>[0]) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (d) => {
      shown += String(d);
      // Answer each question as it is asked.
      if (/\]: $/.test(shown)) {
        shown = "";
        input.write(`${answers.shift() ?? ""}\n`);
      }
    });
    return askTools(preselected, input, output);
  };

  it("keeps the pre-selection on Enter, or all tools when nothing is pre-selected", async () => {
    expect(await ask([""], ["claude-code"])).toEqual(["claude-code"]);
    expect(await ask([""], [])).toEqual(["claude-code", "copilot", "codex"]);
  });

  it("takes the numbers typed, asking again after an invalid answer", async () => {
    expect(await ask(["1,3"], [])).toEqual(["claude-code", "codex"]);
    expect(await ask(["4", "2"], [])).toEqual(["copilot"]);
  });
});

describe("doctor with tools", () => {
  it("checks only the listed tools' skills, and the Stop hook only for Claude Code", async () => {
    initProject(tmp, ["codex"]);
    const messages = (await runDoctor(tmp)).checks.map((c) => c.message);
    expect(messages).toContain(
      `.agents/skills: skills ${JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")).version}`,
    );
    expect(messages.some((m) => m.startsWith(".claude/skills") || m.includes("Stop hook"))).toBe(false);
  });
});
