import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import {
  AGENT_SKILL_DIRS,
  AGENTS_BLOCK,
  HOOK_COMMAND,
  initProject,
  installedSkillVersion,
  installRoot,
  SKILLS,
  stampSkill,
  stopHookState,
  updateProject,
} from "../src/core/install.js";
import { packageVersion } from "../src/core/package.js";

let tmp: string;
const read = (rel: string) => fs.readFileSync(path.join(tmp, rel), "utf8");
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), text);
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "flagrm-install-")));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("initProject", () => {
  it("creates the config, the skills for every agent, AGENTS.md, the Stop hook and the gitignore entry", () => {
    const steps = initProject(tmp);
    expect(steps.every((s) => s.status === "created")).toBe(true);
    expect(read("flagrm.config.yaml")).toContain("projects:");
    for (const dir of AGENT_SKILL_DIRS) {
      for (const skill of SKILLS) {
        expect(installedSkillVersion(path.join(tmp, dir, skill))).toBe(packageVersion());
      }
    }
    expect(fs.existsSync(path.join(tmp, ".cursor"))).toBe(false);
    expect(read("AGENTS.md")).toBe(`${AGENTS_BLOCK}\n`);
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: HOOK_COMMAND }] }]);
    expect(read(".gitignore")).toBe(".flagrm/\n");
  });

  it("skips everything on a second run and changes nothing", () => {
    initProject(tmp);
    const before = ["AGENTS.md", ".claude/settings.json", ".gitignore"].map(read);
    const steps = initProject(tmp);
    expect(steps.every((s) => s.status === "skipped")).toBe(true);
    expect(["AGENTS.md", ".claude/settings.json", ".gitignore"].map(read)).toEqual(before);
  });

  it("keeps existing settings and hooks", () => {
    write(
      ".claude/settings.json",
      JSON.stringify({
        permissions: { allow: ["Bash(ls)"] },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    initProject(tmp);
    const settings = JSON.parse(read(".claude/settings.json"));
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(
      settings.hooks.Stop.flatMap((g: { hooks: Array<{ command: string }> }) => g.hooks.map((h) => h.command)),
    ).toEqual(["echo hi", HOOK_COMMAND]);
  });

  it("skips a settings.json it can't parse, with a note, and still runs the other steps", () => {
    write(".claude/settings.json", "{ not json");
    const steps = initProject(tmp);
    const hook = steps.find((s) => s.path === ".claude/settings.json");
    expect(hook).toMatchObject({ status: "skipped" });
    expect(hook?.note).toContain(HOOK_COMMAND);
    expect(read(".claude/settings.json")).toBe("{ not json");
    expect(read(".gitignore")).toBe(".flagrm/\n");
  });

  it("appends to an existing AGENTS.md and .gitignore", () => {
    write("AGENTS.md", "# Project\n\nUse pnpm.\n");
    write(".gitignore", "node_modules");
    initProject(tmp);
    expect(read("AGENTS.md")).toBe(`# Project\n\nUse pnpm.\n\n${AGENTS_BLOCK}\n`);
    expect(read(".gitignore")).toBe("node_modules\n.flagrm/\n");
  });
});

describe("stampSkill", () => {
  it("adds the version to the frontmatter, replaces an old one and keeps CRLF", () => {
    write("SKILL.md", "---\r\nname: x\r\ndescription: y\r\n---\r\n\r\n# X\r\n");
    const file = path.join(tmp, "SKILL.md");
    stampSkill(file, "0.1.0");
    stampSkill(file, "0.2.0");
    expect(read("SKILL.md")).toBe(
      '---\r\nname: x\r\ndescription: y\r\nmetadata:\r\n  flagrm-version: "0.2.0"\r\n---\r\n\r\n# X\r\n',
    );
    expect(installedSkillVersion(tmp)).toBe("0.2.0");
  });
});

describe("flagrm.config.yaml from detected projects", () => {
  it("lists a .NET solution at the root and an Angular workspace with Jest", () => {
    write("server/Shop.slnx", "");
    write("server/src/Api/Api.csproj", "");
    write("web/angular.json", "{}");
    write("web/jest.config.js", "");
    write("web/projects/admin/angular.json", "{}");
    const step = initProject(tmp).find((s) => s.path === "flagrm.config.yaml");
    expect(step?.note).toBe("detected angular (web/angular.json), dotnet (server/Shop.slnx)");
    const config = read("flagrm.config.yaml");
    expect(config).toContain("  - name: web\n    adapter: angular\n    path: ./web\n");
    expect(config).toContain("npx jest --ci");
    expect(config).toContain(
      "  - name: server\n    adapter: dotnet\n    path: ./server\n    # build: dotnet build Shop.slnx --no-incremental\n",
    );
    expect(config).not.toContain("admin");
  });

  it("names a root project after the repository and falls back to .csproj files without a solution", () => {
    const repo = path.join(tmp, "shop");
    fs.mkdirSync(repo);
    write("shop/src/Api/Api.csproj", "");
    write("shop/src/Core/Core.csproj", "");
    initProject(repo);
    const config = fs.readFileSync(path.join(repo, "flagrm.config.yaml"), "utf8");
    expect(config).toContain(
      "  - name: src\n    adapter: dotnet\n    path: ./src\n    # build: dotnet build --no-incremental\n",
    );
    write("shop/angular.json", "{}");
    fs.rmSync(path.join(repo, "flagrm.config.yaml"));
    initProject(repo);
    expect(fs.readFileSync(path.join(repo, "flagrm.config.yaml"), "utf8")).toContain(
      "  - name: shop\n    adapter: angular\n    path: .\n",
    );
  });

  it("turns directory names into valid project names that the config then loads", () => {
    const repo = path.join(tmp, "my app");
    write("my app/angular.json", "{}");
    write("my app/_legacy/Legacy.sln", "");
    initProject(repo);
    const config = fs.readFileSync(path.join(repo, "flagrm.config.yaml"), "utf8");
    expect(config).toContain("  - name: my-app\n");
    expect(config).toContain("  - name: legacy\n");
    expect(loadConfig({}, repo).projects.map((p) => p.name)).toEqual(["my-app", "legacy"]);
  });

  it("leaves an existing flagrm.config.yml alone instead of writing a .yaml next to it", () => {
    write("flagrm.config.yml", "projects: []\n");
    const step = initProject(tmp).find((s) => s.path.startsWith("flagrm.config"));
    expect(step).toMatchObject({ path: "flagrm.config.yml", status: "skipped" });
    expect(fs.existsSync(path.join(tmp, "flagrm.config.yaml"))).toBe(false);
  });

  it("writes the example projects when it finds none", () => {
    const step = initProject(tmp).find((s) => s.path === "flagrm.config.yaml");
    expect(step?.note).toContain("no Angular or .NET project found");
    expect(read("flagrm.config.yaml")).toContain("path: ./frontend");
    expect(read("flagrm.config.yaml")).toContain("path: ./backend");
  });
});

describe("updateProject", () => {
  it("refreshes an outdated skill and reports the rest unchanged", () => {
    initProject(tmp);
    const stale = path.join(tmp, ".claude/skills/flagrm-remove");
    stampSkill(path.join(stale, "SKILL.md"), "0.0.1");
    const steps = updateProject(tmp);
    expect(steps.find((s) => s.path === ".claude/skills/flagrm-remove")?.status).toBe("updated");
    expect(steps.filter((s) => s.status === "updated")).toHaveLength(1);
    expect(installedSkillVersion(stale)).toBe(packageVersion());
  });

  it("doesn't install into agent directories init didn't set up", () => {
    initProject(tmp);
    fs.rmSync(path.join(tmp, ".agents"), { recursive: true });
    updateProject(tmp);
    expect(fs.existsSync(path.join(tmp, ".agents"))).toBe(false);
  });

  it("refreshes the hook command and the AGENTS.md block, keeping the rest", () => {
    initProject(tmp);
    const settingsFile = ".claude/settings.json";
    write(settingsFile, read(settingsFile).replace(HOOK_COMMAND, "npx flagrm@0.1.0 hook stop"));
    write("AGENTS.md", `# Project\n\n${AGENTS_BLOCK.replace("follow", "read")}\n\nMore.\n`);
    const steps = updateProject(tmp);
    expect(steps.find((s) => s.path === settingsFile)?.status).toBe("updated");
    expect(read(settingsFile)).toContain(`"${HOOK_COMMAND}"`);
    expect(read("AGENTS.md")).toBe(`# Project\n\n${AGENTS_BLOCK}\n\nMore.\n`);
  });

  it("replaces the POSIX-only hook command of earlier versions", () => {
    initProject(tmp);
    const settingsFile = ".claude/settings.json";
    write(
      settingsFile,
      read(settingsFile).replace(HOOK_COMMAND, "npx --no-install flagrm hook stop 2>/dev/null || flagrm hook stop"),
    );
    expect(stopHookState(tmp)).toBe("outdated");
    expect(updateProject(tmp).find((s) => s.path === settingsFile)?.status).toBe("updated");
    expect(stopHookState(tmp)).toBe("current");
  });

  it("does nothing in a repository without flagrm", () => {
    const steps = updateProject(tmp);
    expect(steps.every((s) => s.status === "skipped")).toBe(true);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});

describe("installRoot", () => {
  it("is the directory of the nearest config up to the repository root, or the repository root without one", () => {
    write("backend/src/x.cs", "");
    expect(installRoot(path.join(tmp, "backend"))).toBe(path.join(tmp, "backend"));
    fs.mkdirSync(path.join(tmp, ".git"));
    expect(installRoot(path.join(tmp, "backend"))).toBe(tmp);
    write("flagrm.config.yaml", "projects: []\n");
    expect(installRoot(path.join(tmp, "backend", "src"))).toBe(tmp);
  });
});
