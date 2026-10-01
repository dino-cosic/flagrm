import type { ProjectContext } from "../../src/core/adapter.js";
import {
  type AdapterId,
  DEFAULT_BACKEND_ATTRIBUTES,
  DEFAULT_BACKEND_METHODS,
  DEFAULT_FRONTEND_METHODS,
  type ProjectConfig,
  type ToolConfig,
} from "../../src/core/config.js";
import { createProjectContext } from "../../src/core/registry.js";

/**
 * Build a ProjectContext for one project the way the CLI would, with the
 * adapter's default methods/attributes unless overridden.
 */
export function projectContext(
  adapter: AdapterId,
  dir: string,
  overrides: Partial<ProjectConfig> = {},
  config: Partial<ToolConfig> = {},
): ProjectContext {
  const project: ProjectConfig = {
    name: adapter === "angular" ? "frontend" : "backend",
    adapter,
    path: dir,
    methods: adapter === "angular" ? DEFAULT_FRONTEND_METHODS : DEFAULT_BACKEND_METHODS,
    attributes: adapter === "angular" ? [] : DEFAULT_BACKEND_ATTRIBUTES,
    ...overrides,
  };
  return createProjectContext(project, {
    root: dir,
    projects: [project],
    exclude: [],
    include: [],
    ...config,
  });
}
