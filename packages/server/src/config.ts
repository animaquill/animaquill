import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { STAGING_DIR } from "./lfs/staging.ts";
import {
  LIBRARY_SECRET,
  describeLibrary,
  loadLibraryConfig,
  type LibraryConfig,
} from "./library/config.ts";
import { parseNetwork } from "./relay/addresses.ts";
import { MasterKeyError, parseMasterKeys, type MasterKey } from "./seal.ts";

/**
 * Everything the API is told, from its environment. Secrets come from a variable or from a file that
 * `<NAME>_FILE` names, never from the repository, and nothing here ever writes a secret to the log:
 * errors name the variable, not its value.
 */
export interface Config {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly logLevel: string;
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    readonly user: string;
    readonly password: string | undefined;
  };
  readonly github: GitHubConfig;
  /** Where users reach the platform, for the addresses GitHub sends them back to. */
  readonly publicOrigin: string;
  /**
   * What seals the secrets the platform keeps, such as the GitHub tokens of users, see seal.ts.
   * Undefined when it is not set or not right: then nobody can sign in, and the rest runs.
   */
  readonly masterKeys: readonly MasterKey[] | undefined;
  /** What is wrong with the settings that are left out, for the log. Names, never values. */
  readonly problems: readonly string[];
  /**
   * The proxies whose X-Forwarded-For says where a request comes from: the gateway, by its name on
   * the Docker network, see proxies.ts. The loopback unless told otherwise.
   */
  readonly trustedProxies: readonly string[];
  /** The relay of AI services, see relay/routes.ts. */
  readonly relay: RelayConfig;
  /** The cloud space and its storage, see library/config.ts. */
  readonly library: LibraryConfig;
  /**
   * LFS_STAGING_DIR: where files on their way into Git LFS wait, the volume `platform_staging`,
   * see lfs/staging.ts. Only names of its own are ever touched in there.
   */
  readonly stagingDir: string;
  /**
   * LFS_MIN_FREE_GB: the disk the staging folder is on keeps this many GiB free, counting what is
   * on its way to it; no new upload is taken below that.
   * Undefined: the default of lfs/uploads.ts, 30.
   */
  readonly stagingFloorGb: number | undefined;
  /**
   * AQ_DATA_DIR: the data folder of the server, a whole path; the repositories of its own are in
   * `repos/` there (archive/local/). `/var/lib/animaquill` unless said.
   */
  readonly dataDir: string;
  /**
   * AQ_LOCAL_REPOS: "on" keeps repositories of the server's own also where the GitHub App is set up,
   * "off" never; unless said, they are kept only where it is not (see `localReposOn`).
   */
  readonly localRepos: "on" | "off" | undefined;
}

export interface RelayConfig {
  /** LLM_RELAY: on unless it says off. */
  readonly enabled: boolean;
  /**
   * LLM_RELAY_DENY: networks or addresses the relay never goes to, besides those not on the
   * internet and those its own name resolves to, such as all public addresses of the server.
   */
  readonly deny: readonly string[];
  /** What is wrong with these settings, for the log. */
  readonly problems: readonly string[];
}

/** The GitHub App. The id and client id are public; the rest are secrets, given by whoever runs the server. */
export interface GitHubConfig {
  readonly appId: string | undefined;
  /** The name of the App in its address, github.com/apps/<slug>, where people install it. */
  readonly appSlug: string | undefined;
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
  readonly webhookSecret: string | undefined;
  readonly privateKey: string | undefined;
  /** Where people sign in and install the App: github.com, or a GitHub of a company. */
  readonly webUrl: string;
  /** Where the REST API of that GitHub is. */
  readonly apiUrl: string;
  /** What is wrong with these settings. They are left out then, and the rest of the API runs. */
  readonly problems: readonly string[];
}

/** The variables that hold secrets, which main.ts takes out of the environment once read. */
export const SECRETS = [
  "DATABASE_PASSWORD",
  "PLATFORM_MASTER_KEY",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  LIBRARY_SECRET,
] as const;

export type Env = Readonly<Record<string, string | undefined>>;
export type Read = (path: string) => string | undefined;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** A file's text, or undefined when there is no such file. Any other failure stops the start. */
export const readIfThere: Read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new ConfigError(`cannot read ${path} (${code ?? "unknown error"})`);
  }
};

export const plain = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

/**
 * A secret from `<NAME>_FILE` or `<NAME>`, not both. With `optionalFile`, a file that is not there
 * counts as not set, so a place for it can be prepared before anyone has one. A `pem` may come on
 * one line with its line breaks written as \n.
 */
export const secret = (
  env: Env,
  name: string,
  read: Read = readIfThere,
  { optionalFile = false, pem = false } = {},
): string | undefined => {
  const path = plain(env, `${name}_FILE`);
  const direct = env[name];
  const fromFile = path === undefined ? undefined : read(path);
  if (path !== undefined && fromFile === undefined && !optionalFile)
    throw new ConfigError(`${name}_FILE names a file that is not there`);
  if (fromFile !== undefined && fromFile.trim() && direct?.trim())
    throw new ConfigError(`${name} and ${name}_FILE are both set; keep one`);
  const value = fromFile?.trim() ? fromFile : direct;
  if (value === undefined) return undefined;
  // A key pasted on one line, the way some editors keep it, with its line breaks written as \n.
  const text = pem && !value.includes("\n") ? value.replaceAll("\\n", "\n") : value;
  return text.trim() ? text.trim() : undefined;
};

const integer = (env: Env, name: string, fallback: number): number => {
  const text = plain(env, name);
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new ConfigError(`${name} has to be a port number`);
  return value;
};

/**
 * Whether a private key is one: a key pasted without its quotes in .env arrives as its first line.
 * The answer names no part of the key.
 */
export const privateKeyProblem = (key: string): string | undefined => {
  try {
    createPrivateKey(key);
    return undefined;
  } catch {
    return key.includes("-----END")
      ? "is not a private key"
      : "is cut short: in .env it needs double quotes around all of its lines";
  }
};

/**
 * The GitHub App. A mistake in here must not take the whole platform down with it: the setting is
 * left out and the problem goes to the log.
 */
const loadGitHub = (env: Env, read: Read): GitHubConfig => {
  const problems: string[] = [];
  const guarded = (name: string, options?: Parameters<typeof secret>[3]) => {
    try {
      return secret(env, name, read, options);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(error.message);
      return undefined;
    }
  };
  let privateKey = guarded("GITHUB_APP_PRIVATE_KEY", { optionalFile: true, pem: true });
  const keyProblem = privateKey === undefined ? undefined : privateKeyProblem(privateKey);
  if (keyProblem) {
    problems.push(`GITHUB_APP_PRIVATE_KEY ${keyProblem}`);
    privateKey = undefined;
  }
  let appSlug = plain(env, "GITHUB_APP_SLUG");
  if (appSlug !== undefined && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(appSlug)) {
    problems.push("GITHUB_APP_SLUG has to be the name of the App in its address, like animaquill");
    appSlug = undefined;
  }
  /** Tests and a GitHub of a company have other addresses; a query or a fragment has no place. */
  const address = (name: string, fallback: string) => {
    const text = plain(env, name) ?? fallback;
    try {
      const url = new URL(text);
      if ((url.protocol === "https:" || url.protocol === "http:") && !url.search && !url.hash)
        return url.href.replace(/\/$/, "");
    } catch {}
    problems.push(`${name} has to be an address like ${fallback}`);
    return fallback;
  };
  return {
    appId: plain(env, "GITHUB_APP_ID"),
    appSlug,
    clientId: plain(env, "GITHUB_CLIENT_ID"),
    clientSecret: guarded("GITHUB_CLIENT_SECRET"),
    webhookSecret: guarded("GITHUB_WEBHOOK_SECRET"),
    privateKey,
    webUrl: address("GITHUB_URL", "https://github.com"),
    apiUrl: address("GITHUB_API_URL", "https://api.github.com"),
    problems,
  };
};

/**
 * The master key, from PLATFORM_MASTER_KEY_FILE, which deploy.sh makes on the first run, or from
 * PLATFORM_MASTER_KEY. Like the App's settings, one that is not right leaves sign-in off, and the
 * rest of the API runs.
 */
const loadMasterKeys = (env: Env, read: Read, problems: string[]) => {
  try {
    const text = secret(env, "PLATFORM_MASTER_KEY", read);
    if (text === undefined) {
      problems.push("PLATFORM_MASTER_KEY is not set: nobody can sign in");
      return undefined;
    }
    return parseMasterKeys(text);
  } catch (error) {
    if (!(error instanceof ConfigError) && !(error instanceof MasterKeyError)) throw error;
    problems.push(`PLATFORM_MASTER_KEY: ${error.message}`);
    return undefined;
  }
};

const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;

/** TRUSTED_PROXIES: addresses or names, separated by commas or spaces. */
const proxiesOf = (env: Env, problems: string[]): readonly string[] => {
  const text = plain(env, "TRUSTED_PROXIES");
  if (text === undefined) return ["127.0.0.1", "::1"];
  const names = text.split(/[\s,]+/).filter(Boolean);
  const good = names.filter((name) => isIP(name) !== 0 || HOST_NAME.test(name));
  if (good.length !== names.length)
    problems.push("TRUSTED_PROXIES has to be addresses or names, separated by commas");
  return good;
};

/**
 * The relay of AI services: on by default, and off with LLM_RELAY=off. Anything else leaves it off
 * and says so in the log: whoever writes something there wants it to be different from the default.
 */
const relayOf = (env: Env): RelayConfig => {
  const problems: string[] = [];
  const switched = plain(env, "LLM_RELAY")?.toLowerCase();
  const enabled = switched === undefined || switched === "on";
  if (switched !== undefined && switched !== "on" && switched !== "off")
    problems.push("LLM_RELAY has to be on or off: the relay of AI services stays off");
  const deny: string[] = [];
  for (const network of (plain(env, "LLM_RELAY_DENY") ?? "").split(/[\s,]+/).filter(Boolean)) {
    try {
      parseNetwork(network);
      deny.push(network);
    } catch {
      problems.push(`LLM_RELAY_DENY: ${network} is not an address or a network like 192.0.2.0/24`);
    }
  }
  return { enabled, deny, problems };
};

/** Where the editor is, without PUBLIC_ORIGIN or a default of the deployment, see `ConfigDefaults`. */
export const LOCAL_ORIGIN = "http://localhost:8300";

const origin = (env: Env, fallback: string): string => {
  const text = plain(env, "PUBLIC_ORIGIN") ?? fallback;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError("PUBLIC_ORIGIN has to be an address like https://editor.example.com");
  }
  if (url.origin !== text.replace(/\/$/, ""))
    throw new ConfigError("PUBLIC_ORIGIN has to be only the scheme and host, without a path");
  return url.origin;
};

/** LFS_MIN_FREE_GB, a number of GiB: anything else leaves the default, and says so. */
const stagingFloorOf = (env: Env, problems: string[]): number | undefined => {
  const text = plain(env, "LFS_MIN_FREE_GB");
  if (text === undefined) return undefined;
  const value = Number(text);
  if (/^\d+(?:\.\d+)?$/.test(text) && Number.isFinite(value)) return value;
  problems.push("LFS_MIN_FREE_GB has to be a number of GiB, like 30");
  return undefined;
};

/** LFS_STAGING_DIR, a folder by its whole path: anything else leaves the default. */
const stagingDirOf = (env: Env, problems: string[]): string => {
  const text = plain(env, "LFS_STAGING_DIR");
  if (text === undefined) return STAGING_DIR;
  if (isAbsolute(text) && !text.includes("\0")) return text;
  problems.push(`LFS_STAGING_DIR has to be a whole path like ${STAGING_DIR}`);
  return STAGING_DIR;
};

export const DATA_DIR = "/var/lib/animaquill";

/** AQ_DATA_DIR, a folder by its whole path: anything else leaves the default. */
const dataDirOf = (env: Env, problems: string[]): string => {
  const text = plain(env, "AQ_DATA_DIR");
  if (text === undefined) return DATA_DIR;
  if (isAbsolute(text) && !text.includes("\0")) return text;
  problems.push(`AQ_DATA_DIR has to be a whole path like ${DATA_DIR}`);
  return DATA_DIR;
};

/** AQ_LOCAL_REPOS: on, off, or nothing said. */
const localReposOf = (env: Env, problems: string[]): "on" | "off" | undefined => {
  const text = plain(env, "AQ_LOCAL_REPOS");
  if (text === undefined) return undefined;
  if (text === "on" || text === "off") return text;
  problems.push("AQ_LOCAL_REPOS has to be on or off");
  return undefined;
};

/**
 * Whether the server keeps repositories of its own: where it is not set up for GitHub (no App
 * key), or where AQ_LOCAL_REPOS says "on"; never where it says "off".
 */
export const localReposOn = (config: Config): boolean =>
  config.localRepos === "on" ||
  (config.localRepos === undefined && (!config.github.privateKey || !config.github.clientId));

/** What a deployment has for itself where the environment says nothing. */
export interface ConfigDefaults {
  /** The site of the editor, for PUBLIC_ORIGIN: `LOCAL_ORIGIN` unless said. */
  readonly publicOrigin?: string;
}

export const loadConfig = (
  env: Env,
  read: Read = readIfThere,
  defaults: ConfigDefaults = {},
): Config => {
  const github = loadGitHub(env, read);
  const problems: string[] = [];
  const masterKeys = loadMasterKeys(env, read, problems);
  const trustedProxies = proxiesOf(env, problems);
  const relay = relayOf(env);
  const publicOrigin = origin(env, defaults.publicOrigin ?? LOCAL_ORIGIN);
  const stagingDir = stagingDirOf(env, problems);
  const stagingFloorGb = stagingFloorOf(env, problems);
  return {
    host: plain(env, "HOST") ?? "0.0.0.0",
    port: integer(env, "PORT", 8300),
    version: plain(env, "AQ_VERSION") ?? "dev",
    logLevel: plain(env, "LOG_LEVEL") ?? "info",
    database: {
      host: plain(env, "DATABASE_HOST") ?? "127.0.0.1",
      port: integer(env, "DATABASE_PORT", 5432),
      name: plain(env, "DATABASE_NAME") ?? "animaquill",
      user: plain(env, "DATABASE_USER") ?? "animaquill",
      password: secret(env, "DATABASE_PASSWORD", read),
    },
    github,
    publicOrigin,
    masterKeys,
    problems,
    trustedProxies,
    relay,
    library: loadLibraryConfig(env, (name) => secret(env, name, read)),
    stagingDir,
    stagingFloorGb,
    dataDir: dataDirOf(env, problems),
    localRepos: localReposOf(env, problems),
  };
};

/** Read, the secrets leave the environment, so that nothing this process starts inherits them. */
export const forgetSecrets = (env: Record<string, string | undefined>) => {
  for (const name of SECRETS) delete env[name];
};

/** What is set up, for the log at start: names and yes or no, never values. */
export const describeConfig = (config: Config) => ({
  version: config.version,
  database: `${config.database.user}@${config.database.host}:${config.database.port}/${config.database.name}`,
  databasePassword: config.database.password !== undefined,
  github: {
    appId: config.github.appId ?? null,
    appSlug: config.github.appSlug ?? null,
    clientId: config.github.clientId ?? null,
    clientSecret: config.github.clientSecret !== undefined,
    webhookSecret: config.github.webhookSecret !== undefined,
    privateKey: config.github.privateKey !== undefined,
    ...(config.github.webUrl !== "https://github.com" && { webUrl: config.github.webUrl }),
    ...(config.github.apiUrl !== "https://api.github.com" && { apiUrl: config.github.apiUrl }),
  },
  publicOrigin: config.publicOrigin,
  trustedProxies: config.trustedProxies,
  // Which versions there are, never the keys.
  masterKeys: config.masterKeys?.map((key) => key.version) ?? null,
  relay: { enabled: config.relay.enabled, deny: config.relay.deny },
  library: describeLibrary(config.library),
  stagingDir: config.stagingDir,
  ...(config.stagingFloorGb !== undefined && { stagingFloorGb: config.stagingFloorGb }),
  dataDir: config.dataDir,
  localRepos: localReposOn(config),
});
