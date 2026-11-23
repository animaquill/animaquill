import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Secrets the platform keeps, such as the GitHub tokens of users, are sealed with the master key
 * before they go into the database: AES-256-GCM, a random nonce for each value, and the version of
 * the key in front, so that a new key can take over while values sealed with the old one still open.
 *
 * A sealed value is bound to what it is (its purpose) and to whom it belongs (its context), say the
 * access token of one user: put in another row, or read as something else, it does not open. Nothing
 * here ever says anything about a key or a value: errors name what failed, not what it was.
 */

/** One version of the master key. */
export interface MasterKey {
  readonly version: number;
  readonly key: Buffer;
}

export const MASTER_KEY_BYTES = 32;
const FORMAT = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The format, then the version of the key as four bytes. */
const HEADER_BYTES = 1 + 4;
const MAX_VERSION = 0x7fffffff;

/** What a sealed value is, which goes into its subkey and into what it is bound to. */
export type Purpose = "github-token" | "login-verifier" | "ai-key";

export class MasterKeyError extends Error {
  override name = "MasterKeyError";
}

export class SealError extends Error {
  override name = "SealError";
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The master keys from their file: a line for each version, `<version>:<the key in base64>`, as
 * deploy.sh writes it, `1:` for the first one. The highest version seals; all of them open. Blank
 * lines do not count. What is wrong is said by line number, never with the key in it.
 */
export const parseMasterKeys = (text: string): MasterKey[] => {
  const keys: MasterKey[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line) continue;
    const where = `line ${index + 1}`;
    const match = /^(\d{1,10}):(.*)$/.exec(line);
    if (!match) throw new MasterKeyError(`${where} has to be <version>:<key in base64>`);
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version < 1 || version > MAX_VERSION)
      throw new MasterKeyError(`${where}: the version has to be a whole number from 1`);
    const encoded = (match[2] ?? "").trim();
    const key = BASE64.test(encoded) ? Buffer.from(encoded, "base64") : undefined;
    if (key?.length !== MASTER_KEY_BYTES)
      throw new MasterKeyError(`${where}: the key has to be ${MASTER_KEY_BYTES} bytes in base64`);
    if (keys.some((other) => other.version === version))
      throw new MasterKeyError(`${where}: version ${version} is there twice`);
    keys.push({ version, key });
  }
  if (keys.length === 0) throw new MasterKeyError("there is no key in it");
  return keys;
};

const header = (version: number) => {
  const bytes = Buffer.alloc(HEADER_BYTES);
  bytes.writeUInt8(FORMAT, 0);
  bytes.writeUInt32BE(version, 1);
  return bytes;
};

/** What the tag covers besides the value: its header, its purpose and whose it is. */
const boundTo = (head: Buffer, purpose: Purpose, context: string) =>
  Buffer.concat([head, Buffer.from(`${purpose}\0${context}`, "utf8")]);

export interface Sealer {
  /** The version new values are sealed with. */
  readonly version: number;
  seal(value: string, purpose: Purpose, context: string): Buffer;
  /** Throws a SealError for anything that was not sealed this way, with these keys, for this. */
  open(sealed: Buffer, purpose: Purpose, context: string): string;
  /** The version of the key a value was sealed with, for moving values to a new key. */
  versionOf(sealed: Buffer): number | undefined;
}

export const createSealer = (keys: readonly MasterKey[]): Sealer => {
  if (keys.length === 0) throw new MasterKeyError("there is no key");
  const byVersion = new Map(keys.map((key) => [key.version, key.key]));
  const newest = Math.max(...byVersion.keys());
  // Each purpose has a key of its own, made from the master key, so that one never stands in for
  // another, and the master key can be used for something else one day.
  const subkeys = new Map<string, Buffer>();
  const subkey = (version: number, purpose: Purpose) => {
    const name = `${version}/${purpose}`;
    let key = subkeys.get(name);
    if (!key) {
      const master = byVersion.get(version);
      if (!master) return undefined;
      key = Buffer.from(hkdfSync("sha256", master, "animaquill-seal", `animaquill:${purpose}`, 32));
      subkeys.set(name, key);
    }
    return key;
  };

  return {
    version: newest,
    seal(value, purpose, context) {
      const head = header(newest);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", subkey(newest, purpose)!, nonce);
      cipher.setAAD(boundTo(head, purpose, context));
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([head, nonce, body, cipher.getAuthTag()]);
    },
    open(sealed, purpose, context) {
      if (!Buffer.isBuffer(sealed) || sealed.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES)
        throw new SealError("not a sealed value");
      if (sealed.readUInt8(0) !== FORMAT) throw new SealError("a format this does not know");
      const version = sealed.readUInt32BE(1);
      const key = subkey(version, purpose);
      if (!key) throw new SealError(`sealed with key version ${version}, which is not here`);
      const head = sealed.subarray(0, HEADER_BYTES);
      const nonce = sealed.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
      const body = sealed.subarray(HEADER_BYTES + NONCE_BYTES, sealed.length - TAG_BYTES);
      const tag = sealed.subarray(sealed.length - TAG_BYTES);
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(boundTo(head, purpose, context));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
      } catch {
        throw new SealError("does not open: changed, or sealed for something else");
      }
    },
    versionOf(sealed) {
      return Buffer.isBuffer(sealed) && sealed.length >= HEADER_BYTES && sealed[0] === FORMAT
        ? sealed.readUInt32BE(1)
        : undefined;
    },
  };
};

/** A random value people's browsers carry, such as the id of a session: 32 bytes, URL-safe. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** What the database keeps of such a value, so that reading the database is not enough to use it. */
export const hashOf = (value: string): Buffer =>
  createHash("sha256").update(value, "utf8").digest();
