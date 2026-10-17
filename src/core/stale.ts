/**
 * `flagrm stale`: which flags a flag service says are ready to remove from
 * code. Pure: it takes what the source read, the code names from `flagrm
 * list`'s inventory, the conditions and the time to count days to, and does
 * no I/O, so every verdict is reproducible.
 */

import type { LaunchDarklyConfig } from "./config.js";
import type { SourceFlag, SourceRead } from "./sources/types.js";
import {
  JSON_SCHEMA_VERSION,
  type StaleConditions,
  type StaleEnvironment,
  type StaleFlag,
  type StaleReport,
} from "./types.js";
import { plural } from "./util.js";

const DAY_MS = 86_400_000;

/** Case and separators (`-`, `_`, `.`, spaces) don't matter: `new-checkout` and `NewCheckout` are the same name. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.\s]/g, "");
}

export type KeyMatch =
  | { kind: "matched"; codeName: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "none"; reason?: string };

/**
 * The code name each LaunchDarkly key matches: a `map` entry first, then the
 * exact name, then the normalized one. A normalized name shared by several
 * code names, or by several keys, matches none of them: it would be a guess.
 */
export function matchKeys(keys: string[], codeNames: string[], map: Record<string, string>): Map<string, KeyMatch> {
  const result = new Map<string, KeyMatch>();
  const code = new Set(codeNames);
  const claimed = new Set<string>();
  for (const key of keys) {
    const mapped = map[key];
    if (mapped === undefined) continue;
    if (code.has(mapped)) {
      result.set(key, { kind: "matched", codeName: mapped });
      claimed.add(mapped);
    } else result.set(key, { kind: "none", reason: `map names "${mapped}", which the code doesn't define or use` });
  }
  for (const key of keys) {
    if (!result.has(key) && code.has(key) && !claimed.has(key)) {
      result.set(key, { kind: "matched", codeName: key });
      claimed.add(key);
    }
  }
  const group = (names: string[]) => {
    const groups = new Map<string, string[]>();
    for (const n of names) groups.set(normalizeName(n), [...(groups.get(normalizeName(n)) ?? []), n]);
    return groups;
  };
  const restKeys = keys.filter((k) => !result.has(k));
  const codeByName = group(codeNames.filter((n) => !claimed.has(n)));
  const keysByName = group(restKeys);
  const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(", ");
  for (const key of restKeys) {
    const name = normalizeName(key);
    const candidates = codeByName.get(name) ?? [];
    const rivals = (keysByName.get(name) ?? []).filter((k) => k !== key);
    if (candidates.length === 0) result.set(key, { kind: "none" });
    else if (candidates.length > 1) {
      result.set(key, {
        kind: "ambiguous",
        reason: `ambiguous: code names ${quoted(candidates)} all match; add a launchdarkly.map entry`,
      });
    } else if (rivals.length) {
      result.set(key, {
        kind: "ambiguous",
        reason: `ambiguous: LaunchDarkly keys ${quoted([key, ...rivals])} all match code name "${candidates[0]}"; add a launchdarkly.map entry`,
      });
    } else result.set(key, { kind: "matched", codeName: candidates[0] });
  }
  return result;
}

export function conditionsOf(config: LaunchDarklyConfig, environments: string[]): StaleConditions {
  return { environments, minDaysOn: config.minDaysOn, temporaryOnly: config.temporaryOnly, tags: config.tags };
}

/** Why the flag's own settings (kind, temporary, tags) rule it out, whatever its environments serve. */
function settingReasons(flag: SourceFlag, conditions: Pick<StaleConditions, "temporaryOnly" | "tags">): string[] {
  const reasons: string[] = [];
  if (flag.kind !== "boolean") reasons.push(`not a boolean flag (${flag.kind})`);
  if (conditions.temporaryOnly && !flag.temporary) reasons.push("permanent: not marked temporary in LaunchDarkly");
  for (const tag of conditions.tags.include) if (!flag.tags.includes(tag)) reasons.push(`lacks tag "${tag}"`);
  for (const tag of conditions.tags.exclude) if (flag.tags.includes(tag)) reasons.push(`has excluded tag "${tag}"`);
  return reasons;
}

/**
 * Whether the flag's change history can decide its verdict, so it is worth
 * the audit-log requests: it passes every condition but the days, and a code
 * name matches it.
 */
export function needsHistory(flag: SourceFlag, config: LaunchDarklyConfig, codeNames: string[]): boolean {
  if (flag.unrecognized || settingReasons(flag, config).length) return false;
  // A recognized flag has every checked environment.
  const served = Object.values(flag.environments).map((e) => e.serves);
  if (!served.length || !served.every((s) => s.kind === "fixed" && s.value === true)) return false;
  const name = normalizeName(config.map[flag.key] ?? flag.key);
  return codeNames.some((n) => normalizeName(n) === name);
}

/** Each checked environment as reported, with whole days since `since`. */
function environmentsOf(flag: SourceFlag, environments: string[], now: Date): StaleEnvironment[] {
  return environments.flatMap((environment): StaleEnvironment[] => {
    const state = flag.environments[environment];
    if (!state) return [];
    if (state.serves.kind === "targeted") return [{ environment, serves: "targeted", detail: state.serves.detail }];
    const days = state.since ? Math.floor((now.getTime() - Date.parse(state.since)) / DAY_MS) : undefined;
    return [
      {
        environment,
        serves: "fixed",
        value: state.serves.value,
        ...(state.since ? { since: state.since, sinceSource: state.sinceSource, days } : {}),
      },
    ];
  });
}

function evaluateFlag(flag: SourceFlag, match: KeyMatch, conditions: StaleConditions, now: Date): StaleFlag {
  const environments = environmentsOf(flag, conditions.environments, now);
  const base = { key: flag.key, ...(match.kind === "matched" ? { codeName: match.codeName } : {}), environments };
  if (flag.unrecognized) return { ...base, verdict: "keep", reasons: [flag.unrecognized] };
  if (match.kind === "none") return { ...base, verdict: "unreferenced", reasons: match.reason ? [match.reason] : [] };
  if (match.kind === "ambiguous") return { ...base, verdict: "keep", reasons: [match.reason] };
  const reasons = settingReasons(flag, conditions);
  for (const env of environments) {
    if (env.serves === "targeted") reasons.push(`${env.environment}: targeted (${env.detail})`);
    else if (env.value !== true) reasons.push(`${env.environment}: serves ${JSON.stringify(env.value)}`);
    else if ((env.days ?? 0) < conditions.minDaysOn) {
      reasons.push(`${env.environment}: true for only ${plural(env.days ?? 0, "day")} (needs ${conditions.minDaysOn})`);
    }
  }
  return { ...base, verdict: reasons.length ? "keep" : "remove", reasons };
}

/** Up to three names closest to `name` (normalized edit distance), for a "did you mean". */
export function closestNames(name: string, names: string[]): string[] {
  const target = normalizeName(name);
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) {
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      row = next;
    }
    return row[b.length];
  };
  return [...new Set(names)]
    .map((n) => ({ n, d: distance(target, normalizeName(n)) }))
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, 3)
    .map((x) => x.n);
}

export interface StaleInput {
  project: string;
  read: SourceRead;
  /** Code names from `flagrm list`'s inventory. */
  codeNames: string[];
  config: LaunchDarklyConfig;
  now: Date;
  /** The flags asked for (LaunchDarkly keys or code names); all LaunchDarkly flags when empty. */
  only?: string[];
}

/** A name in `only` that neither a LaunchDarkly flag nor a code name matches: a usage error. */
export class UnknownFlagError extends Error {}

export function evaluateStale(input: StaleInput): StaleReport {
  const { read, codeNames, config, now } = input;
  const conditions = conditionsOf(config, read.environments);
  const keys = read.flags.map((f) => f.key);
  const matches = matchKeys(keys, codeNames, config.map);
  const byKey = new Map(read.flags.map((f) => [f.key, f]));

  const flags: StaleFlag[] = [];
  const evaluate = (key: string) => {
    if (!flags.some((f) => f.key === key)) {
      flags.push(evaluateFlag(byKey.get(key)!, matches.get(key)!, conditions, now));
    }
  };
  if (!input.only?.length) keys.forEach(evaluate);
  for (const arg of input.only ?? []) {
    const name = normalizeName(arg);
    const hits = keys.filter((k) => {
      const m = matches.get(k);
      return k === arg || (m?.kind === "matched" && m.codeName === arg);
    });
    const loose = hits.length ? [] : keys.filter((k) => normalizeName(k) === name);
    if (hits.length || loose.length) {
      [...hits, ...loose].forEach(evaluate);
      continue;
    }
    const codeName = codeNames.find((n) => n === arg) ?? codeNames.find((n) => normalizeName(n) === name);
    if (!codeName) {
      throw new UnknownFlagError(
        `No LaunchDarkly flag or code name matches "${arg}". Closest: ${closestNames(arg, [...keys, ...codeNames]).join(", ") || "none"}.`,
      );
    }
    if (flags.some((f) => f.codeName === codeName)) continue;
    flags.push({
      codeName,
      verdict: "keep",
      reasons: [
        `no LaunchDarkly flag matches "${codeName}": if it was archived or deleted, the SDK serves the code's fallback value, which may be OFF`,
      ],
      environments: [],
    });
  }
  const sortKey = (f: StaleFlag) => f.key ?? f.codeName ?? "";
  flags.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    project: input.project,
    evaluatedAt: now.toISOString(),
    conditions,
    flags,
  };
}
