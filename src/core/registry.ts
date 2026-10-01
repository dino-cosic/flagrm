import { angularAdapter } from "../adapters/angular/index.js";
import { dotnetAdapter } from "../adapters/dotnet/index.js";
import { genericAdapter } from "../adapters/generic/index.js";
import type { Adapter, ProjectContext, Workspace } from "./adapter.js";
import type { AdapterId, ProjectConfig, ToolConfig } from "./config.js";
import { listProjectFiles } from "./scan.js";

const ADAPTERS: Record<AdapterId, Adapter> = {
  angular: angularAdapter,
  dotnet: dotnetAdapter,
  generic: genericAdapter,
};

export function getAdapter(id: AdapterId): Adapter {
  return ADAPTERS[id];
}

export function createProjectContext(project: ProjectConfig, config: ToolConfig): ProjectContext {
  const adapter = getAdapter(project.adapter);
  return {
    name: project.name,
    root: project.path,
    project,
    config,
    files: listProjectFiles(project.path, project.globs ?? adapter.defaultGlobs, config),
  };
}

/** Every configured project paired with its adapter, in config order. Throws on an unavailable adapter. */
export function resolveProjects(config: ToolConfig): Workspace {
  return config.projects.map((project) => ({
    adapter: getAdapter(project.adapter),
    ctx: createProjectContext(project, config),
  }));
}
