/**
 * The skills flagrm ships and where each AI tool reads them. Kept apart from
 * `install.ts` so the change filter, which only needs these paths, doesn't
 * depend on the installer.
 */

import { TOOL_IDS, type ToolId } from "./config.js";

export const SKILLS = ["flagrm-remove", "flagrm-review"] as const;

/** Where each supported tool discovers repository skills. */
export const TOOL_SKILL_DIRS: Record<ToolId, string> = {
  "claude-code": ".claude/skills",
  copilot: ".github/skills",
  codex: ".agents/skills",
};

/** Every tool's skills directory: Claude Code, GitHub Copilot, Codex. */
export const AGENT_SKILL_DIRS = TOOL_IDS.map((t) => TOOL_SKILL_DIRS[t]);
