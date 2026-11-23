import { endpointProblem, isBucketName, isSafePrefix } from "@animaquill/host/s3";

/**
 * The settings of the cloud space, from the `LIBRARY_*` lines of the platform's .env: where its
 * S3-compatible storage is, with which key, and the limits around it. Everything that reads them
 * goes through here, and `describeLibrary` says what is in force without the secret, for the log,
 * the command line and later the admin site, which will also switch the mode.
 *
 * Nothing in the code says where the storage is: moving to another service is changing these lines
 * (3.3.5). Like the rest of the configuration, a mistake in here leaves the cloud space off and says
 * why in the log; the rest of the platform runs.
 */

/** In this file and in what people are told, a GB is 1024³ bytes, as the editor and `df -h` count. */
export const GB = 1024 ** 3;

/**
 * on: as usual. readonly: what is stored can be read, nothing new goes in, as while moving to another
 * service. off: neither.
 */
export const LIBRARY_MODES = ["on", "readonly", "off"] as const;
export type LibraryMode = (typeof LIBRARY_MODES)[number];

export interface LibraryStorageConfig {
  /** Where the platform reaches the storage itself, such as http://storage:7070. */
  readonly endpoint: string;
  /** Where browsers reach it, which the addresses they get are signed for. */
  readonly publicEndpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly pathStyle: boolean;
  /** What every key of the cloud space starts with, such as `library/`. */
  readonly prefix: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface LibraryConfig {
  /** LIBRARY_MODE: on unless it says otherwise. See `libraryMode` for what is in force. */
  readonly mode: LibraryMode;
  /** LIBRARY_S3_*: undefined when they are not set, or not right (see `problems`). */
  readonly storage: LibraryStorageConfig | undefined;
  /** LIBRARY_S3_CHECKSUM: whether every part goes up with its SHA-256, which the storage checks. */
  readonly checksum: "sha256" | "none";
  /** LIBRARY_VERIFY: whether the platform reads every upload back and checks its hash. */
  readonly verify: "always" | "never";
  /** LIBRARY_TOTAL_GB, in bytes: what everyone together may keep. Undefined: no such limit. */
  readonly totalBytes: number | undefined;
  /**
   * LIBRARY_MIN_FREE_GB, in bytes, 50 GB unless told otherwise: with less free on the server's disk,
   * nothing new goes up (see disk.ts). 0: no such floor, as with a storage service elsewhere.
   */
  readonly minFreeBytes: number;
  /** What is wrong with these settings, for the log. Names, never values. */
  readonly problems: readonly string[];
}

/** The variable that holds the secret, which main.ts takes out of the environment once read. */
export const LIBRARY_SECRET = "LIBRARY_S3_SECRET_ACCESS_KEY";

/** Every variable read here, which the compose file of the platform passes on to the API and worker. */
export const LIBRARY_VARIABLES = [
  "LIBRARY_MODE",
  "LIBRARY_S3_ENDPOINT",
  "LIBRARY_S3_PUBLIC_ENDPOINT",
  "LIBRARY_S3_REGION",
  "LIBRARY_S3_BUCKET",
  "LIBRARY_S3_PATH_STYLE",
  "LIBRARY_S3_PREFIX",
  "LIBRARY_S3_ACCESS_KEY_ID",
  LIBRARY_SECRET,
  "LIBRARY_S3_CHECKSUM",
  "LIBRARY_VERIFY",
  "LIBRARY_TOTAL_GB",
  "LIBRARY_MIN_FREE_GB",
] as const;

type Env = Readonly<Record<string, string | undefined>>;

const plain = (env: Env, name: string): string | undefined => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

const REGION = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** An access key id goes into every signed address, between slashes: printable, without them. */
const ACCESS_KEY_ID = /^[\x21-\x2e\x30-\x7e]{1,128}$/;

/** A number of GB, at least `least`: what is wrong with it, or its bytes. */
const gigabytes = (
  env: Env,
  name: string,
  least: number,
): { readonly bytes?: number; readonly problem?: string } => {
  const text = plain(env, name);
  if (text === undefined) return {};
  const value = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(value) || value < least || value > 1_000_000)
    return { problem: `${name} has to be a number of GB${least > 0 ? " above 0" : ""}` };
  return { bytes: Math.round(value * GB) };
};

/**
 * Reads the settings. `secretOf` reads the secret as the rest of the configuration does, from the
 * variable or from the file `<NAME>_FILE` names (config.ts), and throws what is wrong with it.
 */
export const loadLibraryConfig = (
  env: Env,
  secretOf: (name: string) => string | undefined,
): LibraryConfig => {
  const problems: string[] = [];
  let off = false;

  const modeText = plain(env, "LIBRARY_MODE")?.toLowerCase();
  let mode: LibraryMode = "on";
  if (modeText !== undefined) {
    if ((LIBRARY_MODES as readonly string[]).includes(modeText)) mode = modeText as LibraryMode;
    else {
      mode = "off";
      problems.push("LIBRARY_MODE has to be on, readonly or off: the cloud space is off");
    }
  }

  const choice = <T extends string>(name: string, values: readonly T[], fallback: T): T => {
    const text = plain(env, name)?.toLowerCase();
    if (text === undefined) return fallback;
    if ((values as readonly string[]).includes(text)) return text as T;
    problems.push(`${name} has to be ${values.join(" or ")}: it is ${fallback} for now`);
    return fallback;
  };
  const checksum = choice("LIBRARY_S3_CHECKSUM", ["sha256", "none"], "sha256");
  const verify = choice("LIBRARY_VERIFY", ["always", "never"], "always");

  // A limit that is wrong leaves the cloud space off: going on without it is going on unlimited.
  const total = gigabytes(env, "LIBRARY_TOTAL_GB", 0.001);
  const floor = gigabytes(env, "LIBRARY_MIN_FREE_GB", 0);
  for (const { problem } of [total, floor])
    if (problem) {
      problems.push(`${problem}: the cloud space is off`);
      off = true;
    }

  const names = [
    "LIBRARY_S3_ENDPOINT",
    "LIBRARY_S3_PUBLIC_ENDPOINT",
    "LIBRARY_S3_BUCKET",
    "LIBRARY_S3_ACCESS_KEY_ID",
  ];
  let secretAccessKey: string | undefined;
  try {
    secretAccessKey = secretOf(LIBRARY_SECRET);
  } catch (error) {
    problems.push(
      `${error instanceof Error ? error.message : String(error)}: the cloud space is off`,
    );
    off = true;
  }
  const anything = names.some((name) => plain(env, name) !== undefined) || secretAccessKey;
  let storage: LibraryStorageConfig | undefined;
  if (anything) {
    const wrong: string[] = [];
    const endpoint = plain(env, "LIBRARY_S3_ENDPOINT");
    const publicEndpoint = plain(env, "LIBRARY_S3_PUBLIC_ENDPOINT") ?? endpoint;
    for (const [name, value] of [
      ["LIBRARY_S3_ENDPOINT", endpoint],
      ["LIBRARY_S3_PUBLIC_ENDPOINT", publicEndpoint],
    ] as const) {
      if (value === undefined) wrong.push(`${name} is not set`);
      else {
        const problem = endpointProblem(value);
        if (problem) wrong.push(`${name} ${problem}`);
      }
    }
    const region = plain(env, "LIBRARY_S3_REGION") ?? "us-east-1";
    if (!REGION.test(region)) wrong.push("LIBRARY_S3_REGION has to be a region like us-east-1");
    const pathText = plain(env, "LIBRARY_S3_PATH_STYLE")?.toLowerCase() ?? "true";
    if (pathText !== "true" && pathText !== "false")
      wrong.push("LIBRARY_S3_PATH_STYLE has to be true or false");
    const pathStyle = pathText !== "false";
    const bucket = plain(env, "LIBRARY_S3_BUCKET");
    if (bucket === undefined) wrong.push("LIBRARY_S3_BUCKET is not set");
    else if (!isBucketName(bucket)) wrong.push("LIBRARY_S3_BUCKET is not a name of a bucket");
    else if (!pathStyle && bucket.includes("."))
      wrong.push("LIBRARY_S3_BUCKET with dots needs LIBRARY_S3_PATH_STYLE=true");
    // Empty is not set, as compose passes a line that .env does not have: there is always a prefix.
    const prefix = plain(env, "LIBRARY_S3_PREFIX") ?? "library/";
    if (!isSafePrefix(prefix) || prefix === "")
      wrong.push("LIBRARY_S3_PREFIX has to be letters, digits and ._- in parts, ending with /");
    // The pictures of conversations are there, in the same bucket (me/chat-images.ts).
    else if (prefix.startsWith("chat-images/"))
      wrong.push("LIBRARY_S3_PREFIX cannot be under where the pictures of conversations are");
    const accessKeyId = plain(env, "LIBRARY_S3_ACCESS_KEY_ID");
    if (accessKeyId === undefined) wrong.push("LIBRARY_S3_ACCESS_KEY_ID is not set");
    else if (!ACCESS_KEY_ID.test(accessKeyId))
      wrong.push("LIBRARY_S3_ACCESS_KEY_ID is not a key id");
    if (secretAccessKey === undefined && !off) wrong.push(`${LIBRARY_SECRET} is not set`);
    if (wrong.length) {
      for (const problem of wrong) problems.push(`${problem}: the cloud space is off`);
    } else if (!off) {
      storage = {
        endpoint: new URL(endpoint!).origin,
        publicEndpoint: new URL(publicEndpoint!).origin,
        region,
        bucket: bucket!,
        pathStyle,
        prefix,
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      };
    }
  }
  return {
    mode,
    storage: off ? undefined : storage,
    checksum,
    verify,
    totalBytes: total.bytes,
    minFreeBytes: floor.bytes ?? 50 * GB,
    problems,
  };
};

/** The mode in force: off without storage. */
export const libraryMode = (config: LibraryConfig): LibraryMode =>
  config.storage ? config.mode : "off";

/** Sizes as admins read them: 0 B, 12.0 KB, 3.4 MB, 45 GB. */
export const sizeText = (bytes: number): string => {
  if (bytes >= GB) return gbText(bytes);
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

/** GB as people read them: 45 GB, 0.5 GB. */
export const gbText = (bytes: number): string => {
  const value = bytes / GB;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(value < 10 ? 2 : 1))} GB`;
};

/**
 * What is in force, as the log, the command line and the admin site say it: never the secret. The
 * access key id is no secret: it is in every address the storage signs.
 */
export const describeLibrary = (config: LibraryConfig) => ({
  mode: libraryMode(config),
  ...(config.mode !== libraryMode(config) && { modeSet: config.mode }),
  storage: config.storage
    ? {
        endpoint: config.storage.endpoint,
        publicEndpoint: config.storage.publicEndpoint,
        region: config.storage.region,
        bucket: config.storage.bucket,
        pathStyle: config.storage.pathStyle,
        prefix: config.storage.prefix,
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: true,
      }
    : null,
  checksum: config.checksum,
  verify: config.verify,
  totalGb: config.totalBytes === undefined ? null : config.totalBytes / GB,
  minFreeGb: config.minFreeBytes / GB,
});
