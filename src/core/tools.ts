/**
 * Which AI coding tools `flagrm init` sets up, and how the choice is made:
 * `--tool`, the `tools:` saved in flagrm.config.yaml, or a question with the
 * tools the repository already uses pre-selected.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import YAML from "yaml";
import { findDefaultConfigFile, parseTools, TOOL_IDS, type ToolId } from "./config.js";
import { relativePath } from "./util.js";

export const TOOL_LABELS: Record<ToolId, string> = {
  "claude-code": "Claude Code",
  copilot: "GitHub Copilot",
  codex: "Codex",
};

/** The tools a repository already uses: `.claude/`, Copilot instructions or skills, AGENTS.md or `.agents/`. */
export function detectTools(root: string): ToolId[] {
  const has = (rel: string) => fs.existsSync(path.join(root, rel));
  const found: Record<ToolId, boolean> = {
    "claude-code": has(".claude"),
    copilot: has(".github/copilot-instructions.md") || has(".github/skills") || has(".github/prompts"),
    codex: has("AGENTS.md") || has(".agents"),
  };
  return TOOL_IDS.filter((t) => found[t]);
}

/** The `tools:` saved in the config file in `root`, if any. Throws on an invalid value. */
export function savedTools(root: string): ToolId[] | undefined {
  const file = findDefaultConfigFile(root);
  if (!file) return undefined;
  const text = fs.readFileSync(file, "utf8");
  const raw = file.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
  return parseTools(raw?.tools, `${path.basename(file)}: tools`);
}

/** Save `tools` in the config file in `root`, in place (comments and layout kept). */
export function saveTools(
  root: string,
  tools: ToolId[],
): { path: string; status: "updated" | "unchanged" | "skipped"; note?: string } {
  const file = findDefaultConfigFile(root);
  if (!file) return { path: "flagrm.config.yaml", status: "skipped" };
  const rel = relativePath(root, file);
  const text = fs.readFileSync(file, "utf8");
  let current: string | undefined;
  try {
    current = savedTools(root)?.join();
  } catch {
    // An invalid `tools:` (say `[cursor]`) is what `init --tool` replaces.
  }
  if (current === tools.join()) return { path: rel, status: "unchanged" };
  let next: string;
  if (file.endsWith(".json")) {
    next = `${JSON.stringify({ ...JSON.parse(text), tools }, null, 2)}\n`;
  } else {
    const doc = YAML.parseDocument(text);
    const seq = doc.createNode(tools);
    seq.flow = true;
    if (doc.has("tools")) doc.set("tools", seq);
    // First, above `projects:`, as the template has it.
    else if (YAML.isMap(doc.contents)) (doc.contents.items as unknown[]).unshift(doc.createPair("tools", seq));
    else return { path: rel, status: "skipped", note: `add \`tools: [${tools.join(", ")}]\`` };
    next = doc.toString();
  }
  if (next === text) return { path: rel, status: "unchanged" };
  fs.writeFileSync(file, next, "utf8");
  return { path: rel, status: "updated", note: `tools: [${tools.join(", ")}]` };
}

/**
 * Ask which tools to set up, with `preselected` checked: the user types the
 * numbers to set up (`1,3`), or presses Enter to keep the pre-selection.
 */
export async function askTools(
  preselected: ToolId[],
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<ToolId[]> {
  const rl = readline.createInterface({ input, output });
  try {
    output.write("Which AI coding tools should flagrm set up?\n");
    TOOL_IDS.forEach((t, i) => {
      output.write(`  ${i + 1}. [${preselected.includes(t) ? "x" : " "}] ${TOOL_LABELS[t]}\n`);
    });
    const fallback = preselected.length ? preselected : [...TOOL_IDS];
    const defaults = fallback.map((t) => TOOL_IDS.indexOf(t) + 1).join(",");
    for (;;) {
      let answer: string;
      try {
        answer = (await rl.question(`Numbers, comma-separated [${defaults}]: `)).trim();
      } catch {
        // Ctrl+D or Ctrl+C: nothing was chosen.
        throw new Error(`Cancelled: no tools chosen. Run flagrm init again, or pass --tool ${TOOL_IDS.join(",")}.`);
      }
      if (!answer) return fallback;
      const picks = answer.split(/[\s,]+/).map(Number);
      if (picks.every((n) => Number.isInteger(n) && n >= 1 && n <= TOOL_IDS.length)) {
        return TOOL_IDS.filter((_, i) => picks.includes(i + 1));
      }
      output.write(`Enter numbers from 1 to ${TOOL_IDS.length}, e.g. 1,3.\n`);
    }
  } finally {
    rl.close();
  }
}
