/**
 * Reads a LaunchDarkly project through the REST API (GET only): its
 * environments, every non-archived flag with full targeting, and, for the
 * flags that could be removed, the audit log to date the last targeting change.
 * `fetch` and `sleep` are injectable so tests never touch the network or wait.
 */

import type { LaunchDarklyConfig } from "../config.js";
import { type FlagSource, type Served, SourceError, type SourceFlag, type SourceRead } from "./types.js";

export const LD_API_VERSION = "20240415";
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 5;
const MAX_WAIT_MS = 60_000;
const PAGE_SIZE = 100;
/** Environments requested per flags listing: kept small, since each adds full targeting to every flag. */
const ENVIRONMENTS_PER_LISTING = 3;
/** The audit log returns at most 20 entries per page. */
const AUDIT_PAGE_SIZE = 20;
const AUDIT_PAGES = 5;

/**
 * Audit-log actions that don't change what an environment serves. Any other
 * action, including one LaunchDarkly adds later, resets `since`: an unknown
 * action can then only shorten the time a flag counts as ON, never lengthen it.
 */
export const NON_TARGETING_ACTIONS: ReadonlySet<string> = new Set([
  "updateName",
  "updateDescription",
  "updateTags",
  "updateTemporary",
  "updateMaintainer",
  "updateDeprecated",
  "updateIncludeInSnippet",
  "updateClientSideFlagAvailability",
  "updateFlagCustomProperties",
  "updateFlagLinks",
  "updateTrackEvents",
  "updateTrackEventsFallthrough",
  "updateFlagSalt",
  "createApprovalRequest",
  "reviewApprovalRequest",
  "deleteApprovalRequest",
  "updateApprovalRequest",
  "createTriggers",
  "updateTriggers",
  "deleteTriggers",
]);

export interface LaunchDarklyOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Epoch milliseconds, for rate-limit reset times. */
  now?: () => number;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number) => new Date(ms).toISOString();

export class LaunchDarklySource implements FlagSource {
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly config: LaunchDarklyConfig,
    private readonly options: LaunchDarklyOptions,
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  async read(wantsHistory: (flag: SourceFlag) => boolean): Promise<SourceRead> {
    const environments = await this.environments();
    const flags = await this.flags(environments);
    for (const { flag, raw } of flags) {
      if (flag.unrecognized) continue;
      const history = wantsHistory(flag);
      for (const [env, state] of Object.entries(flag.environments)) {
        if (state.serves.kind !== "fixed") continue;
        const lastModified = (raw[env] as Json).lastModified as number;
        const audit = history ? await this.lastTargetingChange(flag.key, env) : undefined;
        state.since = iso(audit ?? lastModified);
        state.sinceSource = audit === undefined ? "lastModified" : "audit";
      }
    }
    return { environments, flags: flags.map((f) => f.flag) };
  }

  /** The checked environments: the configured ones, which must exist, or all of the project's. */
  private async environments(): Promise<string[]> {
    const project = encodeURIComponent(this.config.project);
    const keys: string[] = [];
    const environmentsUrl = `/api/v2/projects/${project}/environments?limit=${PAGE_SIZE}`;
    for await (const item of this.pages(environmentsUrl, this.projectNotFound())) {
      if (typeof item.key === "string") keys.push(item.key);
    }
    const wanted = this.config.environments;
    if (!wanted) return keys;
    const unknown = wanted.filter((e) => !keys.includes(e));
    if (unknown.length) {
      throw new Error(
        `launchdarkly.environments: ${unknown.map((e) => `"${e}"`).join(", ")} not in LaunchDarkly project ` +
          `"${this.config.project}". Its environments: ${keys.join(", ") || "none"}.`,
      );
    }
    return wanted;
  }

  /**
   * Every non-archived flag with what each environment serves; `raw` keeps each environment's JSON.
   * The listing leaves archived flags out unless asked for them (`filter=state:archived`), so no filter is sent.
   */
  private async flags(environments: string[]): Promise<Array<{ flag: SourceFlag; raw: Json }>> {
    const project = encodeURIComponent(this.config.project);
    const byKey = new Map<string, { item: Json; envs: Json }>();
    for (let i = 0; i < environments.length; i += ENVIRONMENTS_PER_LISTING) {
      const batch = environments.slice(i, i + ENVIRONMENTS_PER_LISTING);
      const envParams = batch.map((e) => `&env=${encodeURIComponent(e)}`).join("");
      const flagsUrl = `/api/v2/flags/${project}?summary=0&limit=${PAGE_SIZE}${envParams}`;
      for await (const item of this.pages(flagsUrl, this.projectNotFound())) {
        const key = typeof item.key === "string" ? item.key : undefined;
        if (!key) continue;
        const entry = byKey.get(key) ?? { item, envs: {} };
        if (isObject(item.environments)) Object.assign(entry.envs, item.environments);
        byKey.set(key, entry);
      }
    }
    return [...byKey.values()].map(({ item, envs }) => ({ flag: parseFlag(item, envs, environments), raw: envs }));
  }

  /** Epoch ms of the latest audit entry for the flag in `env` that may have changed targeting; undefined when none. */
  private async lastTargetingChange(flagKey: string, env: string): Promise<number | undefined> {
    const spec = `proj/${this.config.project}:env/${env}:flag/${flagKey}`;
    let before: number | undefined;
    for (let page = 0; page < AUDIT_PAGES; page++) {
      const query = `spec=${encodeURIComponent(spec)}&limit=${AUDIT_PAGE_SIZE}${before ? `&before=${before}` : ""}`;
      const body = await this.get(`/api/v2/auditlog?${query}`);
      const items = Array.isArray(body.items) ? body.items.filter(isObject) : [];
      const dated = items.filter((i) => typeof i.date === "number");
      // The log lists newest first, but take the latest targeting entry of the page rather than rely on it.
      const changes = dated.filter(changesTargeting).map((i) => i.date as number);
      if (changes.length) return Math.max(...changes);
      if (dated.length < AUDIT_PAGE_SIZE) return undefined;
      before = Math.min(...dated.map((i) => i.date as number));
    }
    return undefined;
  }

  /** Each item of a paginated listing, following `_links.next`. */
  private async *pages(first: string, notFound?: string): AsyncGenerator<Json> {
    for (let next: string | undefined = first; next; ) {
      const body = await this.get(next, notFound);
      if (!Array.isArray(body.items)) throw new SourceError(`LaunchDarkly returned no items list for GET ${next}`);
      yield* body.items.filter(isObject);
      const links = isObject(body._links) && isObject(body._links.next) ? body._links.next : undefined;
      next = typeof links?.href === "string" ? links.href : undefined;
    }
  }

  /**
   * GET `target` as JSON, retrying rate limits; every failure is a {@link SourceError}, a 404 with `notFound`
   * as its message when given. `target` is a path rooted at `baseUrl`, or a `_links` URL on the same origin.
   */
  private async get(target: string, notFound?: string): Promise<Json> {
    const url = this.resolve(target);
    const endpoint = new URL(url).pathname;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(url, {
          method: "GET",
          headers: { Authorization: this.options.token, "LD-API-Version": LD_API_VERSION, Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new SourceError(this.redact(networkMessage(err, endpoint)));
      }
      if (res.status === 429 && attempt < MAX_RETRIES) {
        await this.sleep(this.retryWait(res.headers));
        continue;
      }
      if (res.ok) {
        try {
          const body = await res.json();
          if (isObject(body)) return body;
        } catch {
          // reported below
        }
        throw new SourceError(`LaunchDarkly returned a response that isn't a JSON object for GET ${endpoint}`);
      }
      const message = res.status === 404 && notFound ? `${notFound} (404) at GET ${endpoint}` : undefined;
      throw new SourceError(this.redact(message ?? this.statusMessage(res.status, endpoint)));
    }
  }

  /**
   * The URL for a path (`/api/v2/...`, appended to `baseUrl`) or an absolute `_links` URL. An absolute URL
   * must be on `baseUrl`'s origin: the token is sent with the request, so it never goes to another host.
   */
  private resolve(target: string): string {
    if (target.startsWith("/")) return `${this.config.baseUrl}${target}`;
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new SourceError(`LaunchDarkly returned a link flagrm can't follow: ${target}`);
    }
    if (url.origin !== new URL(this.config.baseUrl).origin) {
      throw new SourceError(`LaunchDarkly returned a link to another host (${url.origin}); not following it`);
    }
    return url.href;
  }

  private projectNotFound(): string {
    return `LaunchDarkly project "${this.config.project}" not found`;
  }

  private statusMessage(status: number, endpoint: string): string {
    const { project, tokenEnv } = this.config;
    if (status === 401) return `LaunchDarkly rejected the token in ${tokenEnv} (401) for GET ${endpoint}`;
    if (status === 403) {
      return `The token in ${tokenEnv} may not read LaunchDarkly project "${project}" (403) for GET ${endpoint}`;
    }
    if (status === 404) return `LaunchDarkly found nothing (404) at GET ${endpoint}`;
    if (status === 429) return `LaunchDarkly kept rate-limiting (429) after ${MAX_RETRIES} retries for GET ${endpoint}`;
    return `LaunchDarkly answered ${status} for GET ${endpoint}`;
  }

  /** Milliseconds to wait before retrying a 429: the longest the headers ask for, at most a minute. */
  private retryWait(headers: Headers): number {
    const waits: number[] = [];
    for (const name of ["X-Ratelimit-Reset", "X-Ratelimit-Auth-Token-Reset"]) {
      const reset = Number(headers.get(name));
      if (headers.get(name) && Number.isFinite(reset)) waits.push(reset - this.now());
    }
    const retryAfter = Number(headers.get("Retry-After"));
    if (headers.get("Retry-After") && Number.isFinite(retryAfter)) waits.push(retryAfter * 1000);
    const wait = waits.length ? Math.max(...waits) : 1000;
    return Math.min(MAX_WAIT_MS, Math.max(0, wait));
  }

  /** Belt and braces: no message may carry the token, whatever an error echoes back. */
  private redact(message: string): string {
    const { token } = this.options;
    return token ? message.split(token).join("***") : message;
  }
}

function networkMessage(err: unknown, endpoint: string): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return `LaunchDarkly didn't answer within ${TIMEOUT_MS / 1000} s for GET ${endpoint}`;
  }
  const cause = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
  return `Couldn't reach LaunchDarkly (${cause}) for GET ${endpoint}`;
}

/** Whether an audit entry may have changed what the environment serves. */
function changesTargeting(entry: Json): boolean {
  const accesses = Array.isArray(entry.accesses) ? entry.accesses.filter(isObject) : [];
  // An entry without readable actions counts as a change: unknown can only shorten the ON time.
  if (accesses.length === 0) return true;
  return accesses.some((a) => typeof a.action !== "string" || !NON_TARGETING_ACTIONS.has(a.action));
}

const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;

/**
 * What one environment serves, from its targeting: `fixed` only when every
 * context gets one variation. Undefined when the data isn't what flagrm expects.
 */
export function servedValue(env: Json, variations: unknown[]): Served | undefined {
  const variation = (index: unknown): Served | undefined =>
    typeof index === "number" && Number.isInteger(index) && index >= 0 && index < variations.length
      ? { kind: "fixed", value: (variations[index] as Json).value }
      : undefined;
  for (const field of ["targets", "contextTargets", "rules", "prerequisites"]) {
    if (env[field] !== undefined && env[field] !== null && !Array.isArray(env[field])) return undefined;
  }
  if (typeof env.on !== "boolean") return undefined;
  if (!env.on) {
    if (env.offVariation === undefined || env.offVariation === null) {
      return { kind: "targeted", detail: "targeting off without an off variation (the code's fallback is served)" };
    }
    return variation(env.offVariation);
  }
  const count = (field: string) => (Array.isArray(env[field]) ? (env[field] as unknown[]).length : 0);
  if (nonEmpty(env.prerequisites)) return { kind: "targeted", detail: `${count("prerequisites")} prerequisite(s)` };
  if (nonEmpty(env.rules)) return { kind: "targeted", detail: `${count("rules")} rule(s)` };
  if (nonEmpty(env.targets) || nonEmpty(env.contextTargets)) return { kind: "targeted", detail: "individual targets" };
  if (!isObject(env.fallthrough)) return undefined;
  if (env.fallthrough.rollout !== undefined && env.fallthrough.rollout !== null) {
    return { kind: "targeted", detail: "a percentage rollout" };
  }
  return variation(env.fallthrough.variation);
}

/** A {@link SourceFlag} from one flags-listing item; `unrecognized` says what didn't parse. */
export function parseFlag(item: Json, envs: Json, environments: string[]): SourceFlag {
  const key = String(item.key);
  const flag: SourceFlag = {
    key,
    name: typeof item.name === "string" ? item.name : key,
    kind: typeof item.kind === "string" ? item.kind : "unknown",
    temporary: item.temporary === true,
    tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : [],
    creationDate: typeof item.creationDate === "number" ? iso(item.creationDate) : "",
    environments: {},
  };
  const problems: string[] = [];
  if (typeof item.kind !== "string") problems.push("no kind");
  if (typeof item.temporary !== "boolean") problems.push("no temporary marker");
  if (!Array.isArray(item.variations) || !item.variations.every(isObject)) problems.push("no variations");
  for (const env of environments) {
    const raw = envs[env];
    if (!isObject(raw)) {
      problems.push(`no targeting for environment "${env}"`);
      continue;
    }
    const serves = Array.isArray(item.variations) ? servedValue(raw, item.variations) : undefined;
    if (!serves) problems.push(`unreadable targeting in "${env}"`);
    else if (serves.kind === "fixed" && typeof raw.lastModified !== "number") {
      problems.push(`no lastModified in "${env}"`);
    } else flag.environments[env] = { serves };
  }
  if (problems.length) flag.unrecognized = `unrecognized LaunchDarkly data: ${problems.join(", ")}`;
  return flag;
}
