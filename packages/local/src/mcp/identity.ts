import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  sign,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import { chmod, mkdir, open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Who the relay of this computer user is (docs/design/online-offline.md of AnimaQuill Cloud, 5.2):
 * an ECDSA P-256 key in `mcp-key`, made the first time and readable by this user only. A page proves
 * the relay is the one it allowed by its signature, which WebCrypto checks; every `animaquill mcp`
 * of this user proves to the others that it can read the key, by a secret drawn from it. Other users
 * of the computer cannot read it, so they can be neither.
 */

export const KEY_FILE = "mcp-key";

export class IdentityRefused extends Error {}

export interface RelayIdentity {
  /** SPKI in base64, which pages remember. */
  readonly publicKey: string;
  /** A signature of the text, as WebCrypto's ECDSA with SHA-256 checks it (r and s), in base64. */
  sign(text: string): string;
  /** A proof of the key for another `animaquill mcp`, see `macOf`. */
  mac(text: string): string;
  /** Whether `mac` gives this for the text. */
  checks(text: string, mac: string): boolean;
}

function identityOf(key: KeyObject): RelayIdentity {
  const publicKey = createPublicKey({ key: key.export({ type: "pkcs8", format: "pem" }) })
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const secret = Buffer.from(
    hkdfSync(
      "sha256",
      key.export({ type: "pkcs8", format: "der" }),
      "animaquill",
      "animaquill-peer",
      32,
    ),
  );
  const mac = (text: string) => createHmac("sha256", secret).update(text).digest("base64");
  return {
    publicKey,
    sign: (text) =>
      sign("sha256", Buffer.from(text), { key, dsaEncoding: "ieee-p1363" }).toString("base64"),
    mac,
    checks(text, given) {
      const expected = Buffer.from(mac(text));
      const got = Buffer.from(given);
      return expected.length === got.length && timingSafeEqual(expected, got);
    },
  };
}

/**
 * The identity of this computer user, made the first time. Refuses a key that others than this user
 * can read (where the system says so: not on Windows, where the folder of the user is the user's).
 */
export async function loadIdentity(home: string): Promise<RelayIdentity> {
  const path = join(home, KEY_FILE);
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    const pem = await readFile(path, "utf8");
    if (process.platform !== "win32") {
      const { mode } = await stat(path);
      if ((mode & 0o077) !== 0) {
        throw new IdentityRefused(
          `${path} can be read by other users of this computer (mode ${(mode & 0o777).toString(8)}); \`chmod 600 ${path}\` keeps it to you.`,
        );
      }
    }
    return identityOf(createPrivateKey(pem));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  try {
    // Made by one of several starting at once: the others read what it wrote.
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(pem);
    } finally {
      await file.close();
    }
    await chmod(path, 0o600).catch(() => {});
    return identityOf(privateKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    for (let tries = 0; tries < 50; tries += 1) {
      const written = await readFile(path, "utf8");
      if (written.includes("END PRIVATE KEY")) return identityOf(createPrivateKey(written));
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new IdentityRefused(`${path} is there and has no key in it.`);
  }
}
