import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  createSealer,
  hashOf,
  MasterKeyError,
  parseMasterKeys,
  randomToken,
  SealError,
  type MasterKey,
} from "./seal.ts";

const key = (version: number): MasterKey => ({ version, key: randomBytes(32) });
const TOKEN = `ghu_${"a".repeat(36)}`;

describe("sealing", () => {
  const sealer = createSealer([key(1)]);

  test("opens what it sealed, for the same purpose and the same owner", () => {
    const sealed = sealer.seal(TOKEN, "github-token", "access:user-1");
    expect(sealer.open(sealed, "github-token", "access:user-1")).toBe(TOKEN);
    expect(sealed.includes(Buffer.from(TOKEN))).toBe(false);
    expect(sealed.toString("latin1")).not.toContain("ghu_");
  });

  test("seals the same value differently every time: each has a nonce of its own", () => {
    const one = sealer.seal(TOKEN, "github-token", "access:user-1");
    const two = sealer.seal(TOKEN, "github-token", "access:user-1");
    expect(one.equals(two)).toBe(false);
    expect(one.subarray(5, 17).equals(two.subarray(5, 17))).toBe(false);
  });

  test("turns away any byte changed: the header, the nonce, the value and the tag", () => {
    const sealed = sealer.seal(TOKEN, "github-token", "access:user-1");
    for (let at = 0; at < sealed.length; at++) {
      const changed = Buffer.from(sealed);
      changed[at] = changed[at]! ^ 0x01;
      expect(() => sealer.open(changed, "github-token", "access:user-1"), `byte ${at}`).toThrow(
        SealError,
      );
    }
    expect(() =>
      sealer.open(sealed.subarray(0, sealed.length - 1), "github-token", "access:user-1"),
    ).toThrow(SealError);
    expect(() =>
      sealer.open(Buffer.concat([sealed, Buffer.from([0])]), "github-token", "access:user-1"),
    ).toThrow(SealError);
    expect(() => sealer.open(Buffer.alloc(10), "github-token", "access:user-1")).toThrow(SealError);
  });

  test("does not open for another owner or another purpose: rows cannot swap their tokens", () => {
    const sealed = sealer.seal(TOKEN, "github-token", "access:user-1");
    expect(() => sealer.open(sealed, "github-token", "access:user-2")).toThrow(SealError);
    expect(() => sealer.open(sealed, "github-token", "refresh:user-1")).toThrow(SealError);
    expect(() => sealer.open(sealed, "login-verifier", "access:user-1")).toThrow(SealError);
  });

  test("does not open with another master key", () => {
    const sealed = sealer.seal(TOKEN, "github-token", "access:user-1");
    expect(() => createSealer([key(1)]).open(sealed, "github-token", "access:user-1")).toThrow(
      SealError,
    );
  });

  test("seals with the newest key, and opens what older keys sealed, for a new key to take over", () => {
    const first = key(1);
    const old = createSealer([first]).seal(TOKEN, "github-token", "access:user-1");
    const rotated = createSealer([first, key(2)]);
    expect(rotated.version).toBe(2);
    expect(rotated.versionOf(old)).toBe(1);
    expect(rotated.open(old, "github-token", "access:user-1")).toBe(TOKEN);
    const fresh = rotated.seal(TOKEN, "github-token", "access:user-1");
    expect(rotated.versionOf(fresh)).toBe(2);
    // Once the old key is gone, what it sealed does not open, and says which version it needs.
    expect(() => createSealer([key(2)]).open(old, "github-token", "access:user-1")).toThrow(
      /version 1/,
    );
  });

  test("says nothing about the value or the key when it fails", () => {
    const keys = [key(1)];
    const sealed = createSealer(keys).seal(TOKEN, "github-token", "access:user-1");
    try {
      createSealer(keys).open(sealed, "github-token", "access:user-2");
    } catch (error) {
      const said = `${String(error)} ${JSON.stringify(error)}`;
      expect(said).not.toContain(TOKEN);
      expect(said).not.toContain(keys[0]!.key.toString("base64"));
    }
  });
});

describe("the master key file", () => {
  const base64 = randomBytes(32).toString("base64");

  test("has a version for each key, the way deploy.sh writes it", () => {
    const keys = parseMasterKeys(`1:${base64}\n`);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.version).toBe(1);
    expect(keys[0]!.key.toString("base64")).toBe(base64);
    const two = parseMasterKeys(`\n1:${base64}\r\n2:${randomBytes(32).toString("base64")}\n\n`);
    expect(two.map((item) => item.version)).toEqual([1, 2]);
  });

  test("turns away what is not right, without the key in what it says", () => {
    const short = randomBytes(16).toString("base64");
    for (const [text, said] of [
      ["", /no key/],
      [base64, /line 1 has to be/],
      [`0:${base64}`, /version/],
      [`1:${short}`, /32 bytes/],
      [`1:${base64.slice(0, -4)}!!!!`, /32 bytes/],
      [`1:${base64}\n1:${base64}`, /twice/],
    ] as const) {
      let error: unknown;
      try {
        parseMasterKeys(text);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, text).toBeInstanceOf(MasterKeyError);
      expect(String(error)).toMatch(said);
      expect(String(error)).not.toContain(base64);
      expect(String(error)).not.toContain(short);
    }
  });
});

describe("random tokens and their hashes", () => {
  test("are long, URL-safe and different", () => {
    const tokens = new Set(Array.from({ length: 100 }, () => randomToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("hash to 32 bytes, the same each time", () => {
    expect(hashOf("abc").equals(hashOf("abc"))).toBe(true);
    expect(hashOf("abc")).toHaveLength(32);
  });
});
