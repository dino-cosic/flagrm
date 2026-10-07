import path from "node:path";
import { describe, expect, it } from "vitest";
import { changeFilter } from "../src/core/change-filter.js";
import type { ProjectConfig } from "../src/core/config.js";

const root = path.resolve("/repo");
const project = (dir: string): ProjectConfig => ({
  name: "api",
  adapter: "dotnet",
  path: path.join(root, dir),
  methods: [],
  attributes: [],
});

describe("changeFilter", () => {
  it("ignores flagrm's own setup files and nothing else by default", () => {
    const ignore = changeFilter();
    for (const rel of [
      "flagrm.config.yaml",
      ".gitignore",
      ".claude/settings.json",
      ".claude/skills/flagrm-remove/SKILL.md",
      ".github/skills/flagrm-verify/SKILL.md",
      ".agents/skills/flagrm-remove/patterns.md",
      ".github/prompts/flagrm-remove.prompt.md",
      "AGENTS.md",
      "backend/flagrm.slnf",
    ])
      expect(ignore(rel), rel).toBe(true);
    for (const rel of ["src/app.ts", ".claude/skills/other/SKILL.md", "backend/Api.sln", "docs/AGENTS.md.bak"])
      expect(ignore(rel), rel).toBe(false);
  });

  it("ignores the config's exclude globs, relative to the config root or to a project's path", () => {
    const ignore = changeFilter({
      root,
      exclude: ["graphify-out/**", "src/Generated/**"],
      projects: [project("backend")],
    });
    expect(ignore("graphify-out/graph.json")).toBe(true);
    expect(ignore("backend/src/Generated/Client.cs")).toBe(true);
    expect(ignore("src/Generated/Client.cs")).toBe(true);
    expect(ignore("backend/src/Checkout.cs")).toBe(false);
  });
});
