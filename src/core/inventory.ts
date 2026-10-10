/**
 * `flagrm list`: turn each adapter's discovery candidates into one inventory
 * entry per flag — its definitions, configured state per environment file,
 * type, direct reference counts and the projects involved.
 */

import path from "node:path";
import type { Workspace } from "./adapter.js";
import { flagWords, mentionsFlag, namesFlag } from "./flag-words.js";
import { findMentions } from "./mentions.js";
import { isTestPath } from "./scan.js";
import {
  type FlagCandidate,
  type FlagFlowName,
  type FlagInventoryEntry,
  type FlagState,
  JSON_SCHEMA_VERSION,
  type ListReport,
} from "./types.js";

/** Every adapter's discovery candidates, without the ones only tests evaluate. */
export async function discoverCandidates(projects: Workspace): Promise<FlagCandidate[]> {
  const candidates: FlagCandidate[] = [];
  for (const { adapter, ctx } of projects) {
    // A literal that only a test passes to an eval method (`isEnabled('DoesNotExist')`) is not a flag.
    const found = await adapter.discover(ctx);
    candidates.push(
      ...found.filter(
        (c) => (c.source !== "eval" && c.source !== "attribute") || !isTestPath(path.relative(ctx.root, c.file)),
      ),
    );
  }
  return candidates;
}

/** Discover every flag across the workspace and build the inventory. */
export async function buildInventory(projects: Workspace): Promise<ListReport> {
  const candidates = await discoverCandidates(projects);

  const entries = new Map<string, FlagInventoryEntry>();
  const involved = new Map<FlagInventoryEntry, Set<string>>();
  for (const c of candidates) {
    let entry = entries.get(c.flag);
    if (!entry) {
      entry = {
        flag: c.flag,
        type: "unknown",
        state: "unconfigured",
        projects: [],
        definitions: [],
        config: [],
        references: { total: 0, files: 0, tests: 0, byProject: {} },
        flow: [],
        parameterizedTests: [],
      };
      entries.set(c.flag, entry);
      involved.set(entry, new Set());
    }
    involved.get(entry)?.add(c.project);
    const location = { project: c.project, file: c.file, line: c.line };
    if (c.source === "config") {
      entry.config.push({
        ...location,
        environment: c.environment ?? "default",
        state: c.state ?? "unknown",
        ...(c.filters ? { filters: c.filters } : {}),
      });
    } else if (c.symbol && c.symbolKind) {
      entry.definitions.push({ kind: c.symbolKind, name: c.symbol, ...location });
    }
  }

  countReferences(projects, [...entries.values()]);
  followFlow(projects, [...entries.values()]);

  const order = projects.map(({ ctx }) => ctx.name);
  const byLocation = (a: { project: string; file: string; line: number }, b: typeof a) =>
    order.indexOf(a.project) - order.indexOf(b.project) || a.file.localeCompare(b.file) || a.line - b.line;
  for (const entry of entries.values()) {
    entry.definitions.sort(byLocation);
    entry.config.sort(byLocation);
    const names = involved.get(entry) ?? new Set();
    for (const name of Object.keys(entry.references.byProject)) names.add(name);
    entry.projects = order.filter((name) => names.has(name));
    Object.assign(entry, summarizeConfig(entry));
  }

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    projects: projects.map(({ ctx }) => ({ name: ctx.name, adapter: ctx.project.adapter })),
    flags: [...entries.values()].sort((a, b) => a.flag.localeCompare(b.flag)),
    candidates,
  };
}

function summarizeConfig(entry: FlagInventoryEntry): Pick<FlagInventoryEntry, "type" | "state"> {
  const states = new Set(entry.config.map((c) => c.state));
  if (states.size === 0) return { type: "unknown", state: "unconfigured" };
  if (states.has("conditional")) return { type: "conditional", state: "conditional" };
  const type = states.has("unknown") ? "unknown" : "boolean";
  const state: FlagState = states.size === 1 && !states.has("unknown") ? (entry.config[0].state as FlagState) : "mixed";
  return { type, state };
}

/**
 * Count each flag's direct references: the flag name as a string literal, or
 * a definition's qualified name (`FLAGS.newCheckout`). Mentions on
 * definition and config lines are the declarations themselves, not uses.
 */
function countReferences(projects: Workspace, entries: FlagInventoryEntry[]): void {
  const byLiteral = new Map<string, FlagInventoryEntry>();
  const byAlias = new Map<string, FlagInventoryEntry>();
  const declared = new Set<string>();
  for (const entry of entries) {
    byLiteral.set(entry.flag, entry);
    for (const d of entry.definitions) {
      byAlias.set(d.name, entry);
      declared.add(`${d.file}:${d.line}`);
    }
    for (const c of entry.config) declared.add(`${c.file}:${c.line}`);
  }

  const mentions = findMentions(
    projects.map(({ ctx }) => ctx),
    [...byLiteral.keys()],
    [...byAlias.keys()],
  );
  const files = new Map<FlagInventoryEntry, Set<string>>();
  for (const m of mentions) {
    const entry = m.kind === "literal" ? byLiteral.get(m.token) : byAlias.get(m.token);
    if (!entry || declared.has(`${m.file}:${m.line}`)) continue;
    const refs = entry.references;
    refs.total++;
    if (m.isTest) refs.tests++;
    refs.byProject[m.project] = (refs.byProject[m.project] ?? 0) + 1;
    const seen = files.get(entry) ?? new Set();
    seen.add(m.file);
    files.set(entry, seen);
  }
  for (const [entry, seen] of files) entry.references.files = seen.size;
}

/**
 * Where each flag's value goes, from the adapters that can follow it. A name
 * is marked `record` when it says it is about the flag; a generic one
 * (`enabled`, `Plural`) recorded as a wrapper would match unrelated code.
 */
function followFlow(projects: Workspace, entries: FlagInventoryEntry[]): void {
  const byFlag = new Map(entries.map((e) => [e.flag, e]));
  const refs = entries.map((e) => ({ flag: e.flag, aliases: e.definitions.map((d) => d.name) }));
  for (const { adapter, ctx } of projects) {
    if (!adapter.flow) continue;
    const { names, tests } = adapter.flow(ctx, refs);
    for (const name of names) {
      const entry = byFlag.get(name.flag);
      if (!entry) continue;
      const words = flagWords([{ name: entry.flag }, ...entry.definitions]);
      const flagNames = [entry.flag, ...entry.definitions.map((d) => d.name.split(".").pop() ?? d.name)];
      // A renamed import of one of the flag's definitions is as specific as the definition.
      const record = name.kind === "alias" || (!name.ambiguous && recordable(name, flagNames, words));
      entry.flow.push({ ...name, record });
    }
    for (const test of tests) byFlag.get(test.flag)?.parameterizedTests.push(test);
  }
}

/**
 * A local, parameter or field is only looked for in its own file, so one of
 * the flag's words in its name is enough (`useVfo1Terminology`). A method or
 * property is looked for everywhere, so its name has to name the flag
 * (`IsNewCheckoutEnabledAsync`); `express` or `GetCheckout` would match
 * unrelated code.
 */
function recordable(name: FlagFlowName, flagNames: string[], words: Set<string>): boolean {
  const scoped = name.kind === "local" || name.kind === "parameter" || name.kind === "field";
  return scoped ? mentionsFlag(name.name, words) : namesFlag(name.name, flagNames, words);
}
