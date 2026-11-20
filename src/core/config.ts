import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { UsageError } from "./errors.js";
import { isObject, splitList } from "./util.js";

export const ADAPTER_IDS = ["angular", "dotnet", "generic"] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

/** The AI coding tools `init` can set up: Claude Code, GitHub Copilot, Codex. */
export const TOOL_IDS = ["claude-code", "copilot", "codex"] as const;

export type ToolId = (typeof TOOL_IDS)[number];

/** `tools:` as configured, checked; undefined when the key is absent. */
export function parseTools(value: unknown, where = "tools"): ToolId[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : typeof value === "string" ? splitList(value) : undefined;
  if (!list) throw new UsageError(`${where} must be a list of ${TOOL_IDS.join(", ")}.`);
  const tools = list.map((t) => String(t).trim()).filter(Boolean);
  for (const t of tools) {
    if (!(TOOL_IDS as readonly string[]).includes(t)) {
      throw new UsageError(`${where}: "${t}" is not one of ${TOOL_IDS.join(", ")}.`);
    }
  }
  return TOOL_IDS.filter((t) => tools.includes(t));
}

/** One configured project, fully resolved (absolute paths, defaults applied). */
export interface ProjectConfig extends ProjectOptions {
  /** Unique name, used to label every reference and result. */
  name: string;
  adapter: AdapterId;
  /** Absolute path to the project root. */
  path: string;
  /** Method names treated as flag evaluations. */
  methods: string[];
  /** Attribute names treated as feature gates (.NET). */
  attributes: string[];
}

/** The `launchdarkly:` section, defaults applied: where `flagrm stale` reads flags and when one is ready to remove. */
export interface LaunchDarklyConfig {
  /** LaunchDarkly project key. */
  project: string;
  /** API base URL without a trailing slash; `https` unless the host is loopback. */
  baseUrl: string;
  /** Name of the environment variable holding the API token (never the token itself). */
  tokenEnv: string;
  /** Environment keys to check; undefined checks every environment of the project. */
  environments?: string[];
  /** Days every checked environment must have served `true`. */
  minDaysOn: number;
  /** Only flags marked temporary in LaunchDarkly qualify. */
  temporaryOnly: boolean;
  tags: { include: string[]; exclude: string[] };
  /** LaunchDarkly key → code name, for keys that don't match a code name by spelling. */
  map: Record<string, string>;
}

export const DEFAULT_LAUNCHDARKLY_BASE_URL = "https://app.launchdarkly.com";
export const DEFAULT_LAUNCHDARKLY_TOKEN_ENV = "LD_API_TOKEN";

export interface ToolConfig {
  /** Directory of the config file (or the working directory without one); `.flagrm/` lives here. */
  root: string;
  /** Absolute path of the config file, when there is one. */
  file?: string;
  /** The AI coding tools `init` set up (`tools:`); undefined when the config doesn't say. */
  tools?: ToolId[];
  projects: ProjectConfig[];
  /** Additional glob patterns to exclude from scanning, on top of the built-in ignore list. */
  exclude: string[];
  /** Additional glob patterns to include, on top of the built-in language globs. */
  include: string[];
  /** The `launchdarkly:` section; undefined when the config has none. */
  launchdarkly?: LaunchDarklyConfig;
}

export const DEFAULT_FRONTEND_METHODS = ["isEnabled", "isFeatureEnabled", "hasFeature", "getFlag", "isOn"];

export const DEFAULT_BACKEND_METHODS = [
  "IsEnabledAsync",
  "IsEnabled",
  "IsFeatureEnabled",
  "BoolVariation",
  "GetFeatureFlag",
  "GetValue<bool>",
];

export const DEFAULT_BACKEND_ATTRIBUTES = ["FeatureGate", "Feature"];

export interface CliPathOptions {
  config?: string;
  /** Additional glob patterns to exclude (unioned with the config file's `exclude`). */
  exclude?: string[];
  /** Additional glob patterns to include (unioned with the config file's `include`). */
  include?: string[];
}

export const CONFIG_FILENAMES = ["flagrm.config.yaml", "flagrm.config.yml", "flagrm.config.json"];

const KNOWN_LAUNCHDARKLY_KEYS = [
  "project",
  "baseUrl",
  "tokenEnv",
  "environments",
  "minDaysOn",
  "temporaryOnly",
  "tags",
  "map",
];

/** Top-level keys removed in 1.0, with what replaces them. */
const REMOVED_CONFIG_KEYS: Record<string, string> = {
  frontend: "a `projects:` entry with `adapter: angular`",
  backend: "a `projects:` entry with `adapter: dotnet`",
  frontendMethods: "`methods:` on the angular project",
  backendMethods: "`methods:` on the dotnet project",
  backendAttributes: "`attributes:` on the dotnet project",
};

const PROJECT_NAME = /^[A-Za-z0-9][\w.-]*$/;

/** A config file's YAML or JSON; a syntax error is the user's to fix and names the file. */
export function parseConfigText(configPath: string, text: string): unknown {
  try {
    return configPath.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
  } catch (err) {
    throw new UsageError(
      `${configPath} is not valid ${configPath.endsWith(".json") ? "JSON" : "YAML"}: ${(err as Error).message}`,
    );
  }
}

/**
 * Each key's parser: `(value, where)` checks the raw value (undefined when the
 * key is absent) and returns it typed, or throws a {@link UsageError} naming
 * `where`. A key table is the one place a key is declared: the known-key list
 * for typo warnings and the parsed type both derive from it.
 */
type KeyParser = (value: unknown, where: string, fileDir: string) => unknown;

/** The parsed values of a key table; absent keys stay optional. */
type Parsed<T extends Record<string, KeyParser>> = { [K in keyof T]?: Exclude<ReturnType<T[K]>, undefined> };

/** Top-level `flagrm.config.yaml` keys. `projects` and `launchdarkly` are only shape-checked here. */
const CONFIG_KEYS = {
  projects: (value) => {
    if (value !== undefined && !Array.isArray(value)) {
      throw new UsageError(`"projects" must be a list of { name, adapter, path } entries.`);
    }
    return value as unknown[] | undefined;
  },
  tools: (value, where) => parseTools(value, where),
  /** Additional glob patterns to exclude from scanning. */
  exclude: optionalStringList,
  /** Additional glob patterns to include. */
  include: optionalStringList,
  launchdarkly: (value) => value,
} satisfies Record<string, KeyParser>;

/**
 * Optional `projects:` entry keys. `name`, `adapter` and `path` are parsed
 * first, by {@link parseProject}, because the others' messages and defaults
 * depend on them.
 */
const PROJECT_KEYS = {
  /** Build command, run inside `path` by `verify`; `false` runs none. Absent: the adapter's default. */
  build: optionalCommand,
  /** Test command, run inside `path` by `verify`; `false` runs none. Absent: the adapter's default. */
  test: optionalCommand,
  /** Lint or type-check command, run inside `path` by `baseline` and `verify`; `false` or absent runs none (no adapter default). */
  lint: optionalCommand,
  /** Absolute path or glob of the JUnit/TRX files `test` writes, so `verify` can count tests. */
  testResults: (value, where, fileDir) => {
    const raw = optionalString(value, where);
    return raw && path.resolve(fileDir, raw);
  },
  /** Seconds each build/test/lint command may run before it is killed and fails; unlimited when absent. */
  timeout: optionalPositiveNumber,
  /** Globs (relative to `path`) replacing the adapter's default language globs. */
  globs: optionalStringList,
  /** Globs (relative to `path`) of the files the project's commands check, for the `coverage` check; absent: everything under `path`. */
  covers: optionalStringList,
  /** Method names treated as flag evaluations; absent: the adapter's defaults. */
  methods: optionalStringList,
  /** Attribute names treated as feature gates (.NET); absent: the adapter's defaults. */
  attributes: optionalStringList,
} satisfies Record<string, KeyParser>;

/** A project's optional settings, as {@link PROJECT_KEYS} parses them. */
export type ProjectOptions = Parsed<typeof PROJECT_KEYS>;

const KNOWN_PROJECT_KEYS = ["name", "adapter", "path", ...Object.keys(PROJECT_KEYS)];

/** Run every parser of `table` over `raw`; only keys with a value end up in the result. */
function parseKeys<T extends Record<string, KeyParser>>(
  table: T,
  raw: Record<string, unknown>,
  where: (key: string) => string,
  fileDir: string,
): Parsed<T> {
  const result: Record<string, unknown> = {};
  for (const [key, parse] of Object.entries(table)) {
    const value = parse(raw[key], where(key), fileDir);
    if (value !== undefined) result[key] = value;
  }
  return result as Parsed<T>;
}

function readConfigFile(configPath: string): Record<string, unknown> {
  const parsed = parseConfigText(configPath, fs.readFileSync(configPath, "utf8"));
  if (!isObject(parsed)) throw new UsageError(`Config file ${configPath} does not contain an object.`);
  for (const [key, replacement] of Object.entries(REMOVED_CONFIG_KEYS)) {
    if (key in parsed) throw new UsageError(`${configPath}: "${key}" was removed in flagrm 1.0; use ${replacement}.`);
  }
  return parsed;
}

/** A warning for each key of `obj` that doesn't match any known option — likely a typo. */
function unknownKeys(obj: object, known: readonly string[], where: string): string[] {
  return Object.keys(obj)
    .filter((k) => !known.includes(k))
    .map((key) => `unknown key "${key}" in ${where} — ignored. Known keys: ${known.join(", ")}`);
}

/**
 * The nearest directory from `cwd` upward that holds a `.git` directory or
 * file, or undefined outside a repository. Inside a submodule or worktree
 * that is the submodule's or worktree's own root.
 */
export function repositoryRoot(cwd: string): string | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * The nearest flagrm config file from `cwd` upward, stopping at the root of the
 * git repository `cwd` is in; outside a repository only `cwd` itself is
 * searched, so a config in a parent or home directory is never picked up.
 * Known limitation: inside a git submodule the search stops at the
 * submodule's root, so a config in the superproject is not found there.
 */
export function findConfigFile(cwd: string): string | undefined {
  const start = path.resolve(cwd);
  const top = repositoryRoot(start);
  for (let dir = start; ; dir = path.dirname(dir)) {
    const file = findDefaultConfigFile(dir);
    if (file) return file;
    if (!top || dir === top) return undefined;
  }
}

/** The directory of {@link findConfigFile}, or undefined when there is none. */
export function findConfigRoot(cwd: string): string | undefined {
  const file = findConfigFile(cwd);
  return file && path.dirname(file);
}

/** The flagrm config file in `cwd` (`flagrm.config.yaml`, `.yml` or `.json`, in that order), if any. */
export function findDefaultConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveProjectDir(base: string, raw: string, label: string): string {
  const abs = path.resolve(base, raw);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new UsageError(`${label} path does not exist or is not a directory: ${abs}`);
  }
  return abs;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${where} must be a non-empty string.`);
  return value;
}

/** A build/test command: a non-empty string, or `false` to run none (not even the adapter's default). */
function optionalCommand(value: unknown, where: string): string | false | undefined {
  if (value === false) return false;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${where} must be a non-empty string or false.`);
  return value;
}

function optionalPositiveNumber(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new UsageError(`${where} must be a positive number of seconds.`);
  }
  return value;
}

function optionalBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new UsageError(`${where} must be true or false.`);
  return value;
}

function optionalPositiveDays(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new UsageError(`${where} must be a positive whole number of days.`);
  }
  return value;
}

function optionalStringMap(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !Object.values(value).every((v) => typeof v === "string" && v.trim())) {
    throw new UsageError(`${where} must map LaunchDarkly keys to code names (strings).`);
  }
  return value as Record<string, string>;
}

function optionalStringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new UsageError(`${where} must be a list of strings.`);
  }
  return value;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The `launchdarkly:` section with defaults applied; undefined when absent. */
function parseLaunchDarkly(raw: unknown, warnings: string[]): LaunchDarklyConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const where = "launchdarkly";
  if (!isObject(raw)) throw new UsageError(`${where} must be an object with at least a "project".`);
  for (const key of ["token", "apiKey"]) {
    if (key in raw) {
      throw new UsageError(
        `${where}.${key}: never put the API token in the config file. Remove it and set the environment ` +
          `variable named by ${where}.tokenEnv (default ${DEFAULT_LAUNCHDARKLY_TOKEN_ENV}) instead.`,
      );
    }
  }
  warnings.push(...unknownKeys(raw, KNOWN_LAUNCHDARKLY_KEYS, `"${where}"`));
  const project = optionalString(raw.project, `${where}.project`);
  if (!project) throw new UsageError(`${where}.project is required: the LaunchDarkly project key.`);

  const baseUrl = (optionalString(raw.baseUrl, `${where}.baseUrl`) ?? DEFAULT_LAUNCHDARKLY_BASE_URL).replace(
    /\/+$/,
    "",
  );
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UsageError(`${where}.baseUrl is not a URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) {
    throw new UsageError(`${where}.baseUrl must use https: the API token is sent to it.`);
  }

  if (raw.tags !== undefined && !isObject(raw.tags)) {
    throw new UsageError(`${where}.tags must be an object with "include" and/or "exclude" lists.`);
  }
  const tags = (raw.tags ?? {}) as Record<string, unknown>;
  warnings.push(...unknownKeys(tags, ["include", "exclude"], `"${where}.tags"`));

  const environments = optionalStringList(raw.environments, `${where}.environments`);
  if (environments?.length === 0) throw new UsageError(`${where}.environments must name at least one environment.`);
  return {
    project,
    baseUrl,
    tokenEnv: optionalString(raw.tokenEnv, `${where}.tokenEnv`) ?? DEFAULT_LAUNCHDARKLY_TOKEN_ENV,
    ...(environments ? { environments } : {}),
    minDaysOn: optionalPositiveDays(raw.minDaysOn, `${where}.minDaysOn`) ?? 30,
    temporaryOnly: optionalBoolean(raw.temporaryOnly, `${where}.temporaryOnly`) ?? true,
    tags: {
      include: optionalStringList(tags.include, `${where}.tags.include`) ?? [],
      exclude: optionalStringList(tags.exclude, `${where}.tags.exclude`) ?? [],
    },
    map: optionalStringMap(raw.map, `${where}.map`) ?? {},
  };
}

/** Per-adapter defaults for whichever of `methods`/`attributes` the project doesn't set. */
function adapterDefaults(
  adapter: AdapterId,
  set: Pick<ProjectOptions, "methods" | "attributes">,
): { methods: string[]; attributes: string[] } {
  const defaults =
    adapter === "angular"
      ? { methods: DEFAULT_FRONTEND_METHODS, attributes: [] }
      : adapter === "dotnet"
        ? { methods: DEFAULT_BACKEND_METHODS, attributes: DEFAULT_BACKEND_ATTRIBUTES }
        : {
            methods: [...new Set([...DEFAULT_FRONTEND_METHODS, ...DEFAULT_BACKEND_METHODS])],
            attributes: DEFAULT_BACKEND_ATTRIBUTES,
          };
  return { methods: set.methods ?? defaults.methods, attributes: set.attributes ?? defaults.attributes };
}

function parseProject(raw: unknown, index: number, fileDir: string, warnings: string[]): ProjectConfig {
  const where = `projects[${index}]`;
  if (!isObject(raw)) throw new UsageError(`${where} must be an object with name, adapter and path.`);
  const { name, adapter, path: dir } = raw;
  if (typeof name !== "string" || !name) throw new UsageError(`${where} is missing a "name".`);
  if (!PROJECT_NAME.test(name)) {
    throw new UsageError(
      `${where}: name "${name}" must start with a letter or digit and contain only letters, digits, _ . -`,
    );
  }
  warnings.push(...unknownKeys(raw, KNOWN_PROJECT_KEYS, `project "${name}"`));
  if (typeof adapter !== "string" || !(ADAPTER_IDS as readonly string[]).includes(adapter)) {
    throw new UsageError(`${where}: adapter "${String(adapter)}" is not one of ${ADAPTER_IDS.join(", ")}.`);
  }
  if (typeof dir !== "string" || !dir) throw new UsageError(`${where} ("${name}") is missing a "path".`);

  const options = parseKeys(PROJECT_KEYS, raw, (key) => `${where}.${key}`, fileDir);
  return {
    name,
    adapter: adapter as AdapterId,
    path: resolveProjectDir(fileDir, dir, `Project "${name}"`),
    ...options,
    ...adapterDefaults(adapter as AdapterId, options),
  };
}

/** The `config` and the warnings to show about it (unknown keys); {@link loadConfig} when they don't matter. */
export interface LoadedConfig {
  config: ToolConfig;
  /** One line each, without a "Warning:" prefix. */
  warnings: string[];
}

/**
 * Merge CLI options with an optional config file and validate everything.
 * Prints nothing: the caller decides whether to show `warnings` (the Stop hook
 * reads the config too, and must print nothing else).
 *
 * Projects come from the config file's `projects:` list.
 */
export function readConfig(cli: CliPathOptions, cwd = process.cwd()): LoadedConfig {
  const warnings: string[] = [];
  let raw: Record<string, unknown> = {};
  let fileDir = cwd;
  // Without --config, the nearest config up to the repository root is the workspace, as it is for the Stop hook.
  const configPath = cli.config ? path.resolve(cwd, cli.config) : findConfigFile(cwd);
  if (cli.config && !fs.existsSync(configPath!)) {
    throw new UsageError(`Config file not found: ${configPath}`);
  }
  if (configPath && fs.existsSync(configPath)) {
    raw = readConfigFile(configPath);
    fileDir = path.dirname(configPath);
    warnings.push(...unknownKeys(raw, Object.keys(CONFIG_KEYS), configPath));
  }
  const file = parseKeys(CONFIG_KEYS, raw, (key) => key, fileDir);

  const projects = (file.projects ?? []).map((p, i) => parseProject(p, i, fileDir, warnings));

  const seen = new Set<string>();
  for (const p of projects) {
    if (seen.has(p.name)) throw new UsageError(`Duplicate project name "${p.name}" in ${configPath ?? "config"}.`);
    seen.add(p.name);
  }

  if (projects.length === 0) {
    throw new UsageError(
      "No projects configured. Add a `projects:` list to flagrm.config.yaml (`flagrm init` writes one).",
    );
  }

  const launchdarkly = parseLaunchDarkly(file.launchdarkly, warnings);
  const config: ToolConfig = {
    root: fileDir,
    file: configPath && fs.existsSync(configPath) ? configPath : undefined,
    ...(file.tools ? { tools: file.tools } : {}),
    projects,
    exclude: [...(file.exclude ?? []), ...(cli.exclude ?? [])],
    include: [...(file.include ?? []), ...(cli.include ?? [])],
    ...(launchdarkly ? { launchdarkly } : {}),
  };
  return { config, warnings };
}

/** {@link readConfig} without the warnings. */
export function loadConfig(cli: CliPathOptions, cwd = process.cwd()): ToolConfig {
  return readConfig(cli, cwd).config;
}
