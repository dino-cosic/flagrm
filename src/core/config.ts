import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export const ADAPTER_IDS = ["angular", "dotnet", "generic"] as const;

export type AdapterId = (typeof ADAPTER_IDS)[number];

/** The AI coding tools `init` can set up: Claude Code, GitHub Copilot, Codex. */
export const TOOL_IDS = ["claude-code", "copilot", "codex"] as const;

export type ToolId = (typeof TOOL_IDS)[number];

/** `tools:` as configured, checked; undefined when the key is absent. */
export function parseTools(value: unknown, where = "tools"): ToolId[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (!list) throw new Error(`${where} must be a list of ${TOOL_IDS.join(", ")}.`);
  const tools = list.map((t) => String(t).trim()).filter(Boolean);
  for (const t of tools) {
    if (!(TOOL_IDS as readonly string[]).includes(t)) {
      throw new Error(`${where}: "${t}" is not one of ${TOOL_IDS.join(", ")}.`);
    }
  }
  return TOOL_IDS.filter((t) => tools.includes(t));
}

/** One configured project, fully resolved (absolute paths, defaults applied). */
export interface ProjectConfig {
  /** Unique name, used to label every reference and result (`"frontend"`/`"backend"` for legacy configs). */
  name: string;
  adapter: AdapterId;
  /** Absolute path to the project root. */
  path: string;
  /** Build command, run inside `path` by `verify`; `false` runs none. Absent: the adapter's default. */
  build?: string | false;
  /** Test command, run inside `path` by `verify`; `false` runs none. Absent: the adapter's default. */
  test?: string | false;
  /** Lint or type-check command, run inside `path` by `baseline` and `verify`; `false` or absent runs none (no adapter default). */
  lint?: string | false;
  /** Seconds each build/test/lint command may run before it is killed and fails; unlimited when absent. */
  timeout?: number;
  /** Absolute path or glob of the JUnit/TRX files `test` writes, so `verify` can count tests. */
  testResults?: string;
  /** Globs (relative to `path`) replacing the adapter's default language globs. */
  globs?: string[];
  /** Globs (relative to `path`) of the files the project's commands check, for the `coverage` check; absent: everything under `path`. */
  covers?: string[];
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
  /** Legacy shortcut: adds (or replaces) an Angular project named `frontend`. */
  frontend?: string;
  /** Legacy shortcut: adds (or replaces) a .NET project named `backend`. */
  backend?: string;
  config?: string;
  /** Additional glob patterns to exclude (unioned with the config file's `exclude`). */
  exclude?: string[];
  /** Additional glob patterns to include (unioned with the config file's `include`). */
  include?: string[];
  /** Don't warn about unknown keys (the Stop hook reads the config too, and must print nothing else). */
  quiet?: boolean;
}

interface ProjectFileShape {
  name?: unknown;
  adapter?: unknown;
  path?: unknown;
  build?: unknown;
  test?: unknown;
  lint?: unknown;
  testResults?: unknown;
  timeout?: unknown;
  globs?: unknown;
  covers?: unknown;
  methods?: unknown;
  attributes?: unknown;
}

interface ConfigFileShape {
  projects?: unknown;
  tools?: unknown;
  frontend?: string;
  backend?: string;
  frontendMethods?: string[];
  backendMethods?: string[];
  backendAttributes?: string[];
  exclude?: string[];
  include?: string[];
  launchdarkly?: unknown;
}

export const CONFIG_FILENAMES = ["flagrm.config.yaml", "flagrm.config.yml", "flagrm.config.json"];

/** Known top-level `flagrm.config.yaml` keys — anything else is likely a typo. */
const KNOWN_CONFIG_KEYS = [
  "projects",
  "tools",
  "frontend",
  "backend",
  "frontendMethods",
  "backendMethods",
  "backendAttributes",
  "exclude",
  "include",
  "launchdarkly",
];

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

const KNOWN_PROJECT_KEYS = [
  "name",
  "adapter",
  "path",
  "build",
  "test",
  "lint",
  "testResults",
  "timeout",
  "globs",
  "covers",
  "methods",
  "attributes",
];

const PROJECT_NAME = /^[A-Za-z0-9][\w.-]*$/;

function readConfigFile(configPath: string): ConfigFileShape {
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = configPath.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file ${configPath} does not contain an object.`);
  }
  const file = parsed as Record<string, unknown>;
  // Checked here so a YAML string (`exclude: "**/gen/**"`) fails instead of being spread into characters.
  for (const key of ["frontend", "backend"] as const) optionalString(file[key], key);
  for (const key of ["frontendMethods", "backendMethods", "backendAttributes", "exclude", "include"] as const) {
    optionalStringList(file[key], key);
  }
  return file as ConfigFileShape;
}

/** Warn (stderr) about keys that don't match any known option — likely a typo. */
function warnOnUnknownKeys(obj: object, known: string[], where: string): void {
  for (const key of Object.keys(obj).filter((k) => !known.includes(k))) {
    console.error(`Warning: unknown key "${key}" in ${where} — ignored. Known keys: ${known.join(", ")}`);
  }
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
    throw new Error(`${label} path does not exist or is not a directory: ${abs}`);
  }
  return abs;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string.`);
  return value;
}

/** A build/test command: a non-empty string, or `false` to run none (not even the adapter's default). */
function optionalCommand(value: unknown, where: string): string | false | undefined {
  if (value === false) return false;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be a non-empty string or false.`);
  return value;
}

function optionalPositiveNumber(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${where} must be a positive number of seconds.`);
  }
  return value;
}

function optionalBoolean(value: unknown, where: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${where} must be true or false.`);
  return value;
}

function optionalPositiveDays(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where} must be a positive whole number of days.`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalStringMap(value: unknown, where: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || !Object.values(value).every((v) => typeof v === "string" && v.trim())) {
    throw new Error(`${where} must map LaunchDarkly keys to code names (strings).`);
  }
  return value as Record<string, string>;
}

function optionalStringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${where} must be a list of strings.`);
  }
  return value;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** The `launchdarkly:` section with defaults applied; undefined when absent. */
function parseLaunchDarkly(raw: unknown, quiet = false): LaunchDarklyConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  const where = "launchdarkly";
  if (!isObject(raw)) throw new Error(`${where} must be an object with at least a "project".`);
  for (const key of ["token", "apiKey"]) {
    if (key in raw) {
      throw new Error(
        `${where}.${key}: never put the API token in the config file. Remove it and set the environment ` +
          `variable named by ${where}.tokenEnv (default ${DEFAULT_LAUNCHDARKLY_TOKEN_ENV}) instead.`,
      );
    }
  }
  if (!quiet) warnOnUnknownKeys(raw, KNOWN_LAUNCHDARKLY_KEYS, `"${where}"`);
  const project = optionalString(raw.project, `${where}.project`);
  if (!project) throw new Error(`${where}.project is required: the LaunchDarkly project key.`);

  const baseUrl = (optionalString(raw.baseUrl, `${where}.baseUrl`) ?? DEFAULT_LAUNCHDARKLY_BASE_URL).replace(
    /\/+$/,
    "",
  );
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`${where}.baseUrl is not a URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) {
    throw new Error(`${where}.baseUrl must use https: the API token is sent to it.`);
  }

  if (raw.tags !== undefined && !isObject(raw.tags)) {
    throw new Error(`${where}.tags must be an object with "include" and/or "exclude" lists.`);
  }
  const tags = (raw.tags ?? {}) as Record<string, unknown>;
  if (!quiet) warnOnUnknownKeys(tags, ["include", "exclude"], `"${where}.tags"`);

  const environments = optionalStringList(raw.environments, `${where}.environments`);
  if (environments?.length === 0) throw new Error(`${where}.environments must name at least one environment.`);
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

/** Per-adapter defaults for `methods`/`attributes`; the legacy top-level keys override the built-ins. */
function adapterDefaults(adapter: AdapterId, file: ConfigFileShape): { methods: string[]; attributes: string[] } {
  const frontend = file.frontendMethods?.length ? file.frontendMethods : DEFAULT_FRONTEND_METHODS;
  const backend = file.backendMethods?.length ? file.backendMethods : DEFAULT_BACKEND_METHODS;
  const attributes = file.backendAttributes?.length ? file.backendAttributes : DEFAULT_BACKEND_ATTRIBUTES;
  if (adapter === "angular") return { methods: frontend, attributes: [] };
  if (adapter === "dotnet") return { methods: backend, attributes };
  return { methods: [...new Set([...frontend, ...backend])], attributes };
}

function parseProject(
  raw: unknown,
  index: number,
  file: ConfigFileShape,
  fileDir: string,
  quiet = false,
): ProjectConfig {
  const where = `projects[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where} must be an object with name, adapter and path.`);
  }
  const p = raw as ProjectFileShape;
  if (typeof p.name !== "string" || !p.name) throw new Error(`${where} is missing a "name".`);
  const name = p.name;
  if (!PROJECT_NAME.test(name)) {
    throw new Error(
      `${where}: name "${name}" must start with a letter or digit and contain only letters, digits, _ . -`,
    );
  }
  if (!quiet) warnOnUnknownKeys(p, KNOWN_PROJECT_KEYS, `project "${name}"`);
  if (typeof p.adapter !== "string" || !(ADAPTER_IDS as readonly string[]).includes(p.adapter)) {
    throw new Error(`${where}: adapter "${String(p.adapter)}" is not one of ${ADAPTER_IDS.join(", ")}.`);
  }
  const adapter = p.adapter as AdapterId;
  if (typeof p.path !== "string" || !p.path) throw new Error(`${where} ("${name}") is missing a "path".`);

  const defaults = adapterDefaults(adapter, file);
  const testResults = optionalString(p.testResults, `${where}.testResults`);
  const project: ProjectConfig = {
    name,
    adapter,
    path: resolveProjectDir(fileDir, p.path, `Project "${name}"`),
    build: optionalCommand(p.build, `${where}.build`),
    test: optionalCommand(p.test, `${where}.test`),
    lint: optionalCommand(p.lint, `${where}.lint`),
    testResults: testResults && path.resolve(fileDir, testResults),
    timeout: optionalPositiveNumber(p.timeout, `${where}.timeout`),
    globs: optionalStringList(p.globs, `${where}.globs`),
    covers: optionalStringList(p.covers, `${where}.covers`),
    methods: optionalStringList(p.methods, `${where}.methods`) ?? defaults.methods,
    attributes: optionalStringList(p.attributes, `${where}.attributes`) ?? defaults.attributes,
  };
  // Keep the resolved shape free of absent optional keys.
  for (const key of ["build", "test", "lint", "testResults", "timeout", "globs", "covers"] as const) {
    if (project[key] === undefined) delete project[key];
  }
  return project;
}

/**
 * Merge CLI options with an optional config file and validate everything.
 *
 * Projects come from `projects:` plus the legacy `frontend:`/`backend:` keys,
 * which become an `angular` project named `frontend` and a `dotnet` project
 * named `backend`. `--frontend`/`--backend` on the CLI replace the project of
 * that name (or add it).
 */
export function loadConfig(cli: CliPathOptions, cwd = process.cwd()): ToolConfig {
  let file: ConfigFileShape = {};
  let fileDir = cwd;
  // Without --config, the nearest config up to the repository root is the workspace, as it is for the Stop hook.
  const configPath = cli.config ? path.resolve(cwd, cli.config) : findConfigFile(cwd);
  if (cli.config && !fs.existsSync(configPath!)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  if (configPath && fs.existsSync(configPath)) {
    file = readConfigFile(configPath);
    fileDir = path.dirname(configPath);
    if (!cli.quiet) warnOnUnknownKeys(file, KNOWN_CONFIG_KEYS, configPath);
  }

  if (file.projects !== undefined && !Array.isArray(file.projects)) {
    throw new Error(`"projects" must be a list of { name, adapter, path } entries.`);
  }
  const projects = ((file.projects as unknown[] | undefined) ?? []).map((raw, i) =>
    parseProject(raw, i, file, fileDir, cli.quiet),
  );

  const legacyProject = (name: "frontend" | "backend", adapter: AdapterId, dir: string): ProjectConfig => ({
    name,
    adapter,
    path: dir,
    ...adapterDefaults(adapter, file),
  });
  if (file.frontend) {
    projects.push(legacyProject("frontend", "angular", resolveProjectDir(fileDir, file.frontend, "Frontend")));
  }
  if (file.backend) {
    projects.push(legacyProject("backend", "dotnet", resolveProjectDir(fileDir, file.backend, "Backend")));
  }

  const seen = new Set<string>();
  for (const p of projects) {
    if (seen.has(p.name)) throw new Error(`Duplicate project name "${p.name}" in ${configPath ?? "config"}.`);
    seen.add(p.name);
  }

  // CLI shortcuts replace a same-named project (keeping its position) or append one.
  for (const [name, adapter, raw] of [
    ["frontend", "angular", cli.frontend],
    ["backend", "dotnet", cli.backend],
  ] as const) {
    if (!raw) continue;
    const label = name === "frontend" ? "Frontend" : "Backend";
    const project = legacyProject(name, adapter, resolveProjectDir(cwd, raw, label));
    const existing = projects.findIndex((p) => p.name === name);
    if (existing === -1) projects.push(project);
    else projects[existing] = project;
  }

  if (projects.length === 0) {
    throw new Error(
      "No projects configured. Add a `projects:` list to flagrm.config.yaml, or pass --frontend and/or --backend.",
    );
  }

  const tools = parseTools(file.tools);
  const launchdarkly = parseLaunchDarkly(file.launchdarkly, cli.quiet);
  return {
    root: fileDir,
    file: configPath && fs.existsSync(configPath) ? configPath : undefined,
    ...(tools ? { tools } : {}),
    projects,
    exclude: [...(file.exclude ?? []), ...(cli.exclude ?? [])],
    include: [...(file.include ?? []), ...(cli.include ?? [])],
    ...(launchdarkly ? { launchdarkly } : {}),
  };
}
