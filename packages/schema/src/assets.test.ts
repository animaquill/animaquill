import { describe, expect, it } from "vitest";
import { Asset, Assets, downloadableFrom, isSameHash } from "./documents.ts";
import { jsonSchemas } from "./json-schema.ts";
import { parseDocument } from "./project.ts";

const HASH = "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU=";
const base = { kind: "video", path: "assets/a.mp4" } as const;

/** Where the issues of an asset are, by the field they are about. */
const issuesOf = (asset: unknown) =>
  Asset.safeParse(asset).error?.issues.map(({ path, message }) => [path.join("."), message]) ?? [];

describe("where the file of an asset is kept", () => {
  it.each([
    ["local", {}],
    ["git", {}],
    ["lfs", { hash: HASH, size: 3 }],
    ["platform", { hash: HASH, size: 3 }],
    ["remote", { url: "https://example.com/a.mp4" }],
  ])("takes %s with what it needs", (storage, fields) => {
    expect(issuesOf({ ...base, storage, ...fields })).toEqual([]);
  });

  it("needs the hash and the size for the cloud space, which finds the file and checks it", () => {
    expect(issuesOf({ ...base, storage: "platform", size: 3 })).toEqual([
      ["hash", "platform 素材要写 hash"],
    ]);
    expect(issuesOf({ ...base, storage: "platform", hash: HASH })).toEqual([
      ["size", "platform 素材要写 size"],
    ]);
    expect(issuesOf({ ...base, storage: "platform" }).map(([path]) => path)).toEqual([
      "hash",
      "size",
    ]);
  });

  it("takes lfs without them, as projects from before 2026-11-10 have it", () => {
    expect(issuesOf({ ...base, storage: "lfs" })).toEqual([]);
    expect(issuesOf({ ...base, storage: "lfs", hash: HASH })).toEqual([]);
  });

  it("needs the address of a remote file, and only an https one", () => {
    expect(issuesOf({ ...base, storage: "remote", hash: HASH, size: 3 })).toEqual([
      ["url", "remote 素材要写 url"],
    ]);
    expect(issuesOf({ ...base, storage: "remote", url: "http://example.com/a.mp4" })).toEqual([
      ["url", "只支持 https 地址"],
    ]);
  });

  it("needs nothing else for a file that is only here, or in the person's own Git", () => {
    expect(issuesOf({ ...base, storage: "local" })).toEqual([]);
    expect(issuesOf({ ...base, storage: "git" })).toEqual([]);
  });

  it("knows no other place", () => {
    expect(issuesOf({ ...base, storage: "s3", url: "https://example.com/a" })).toHaveLength(1);
  });

  it("says in a file where the field is missing", () => {
    const text = JSON.stringify({ assets: { a: { ...base, storage: "platform", hash: HASH } } });
    expect(parseDocument("assets.json", text, Assets).problems).toMatchObject([
      { severity: "error", file: "assets.json", path: "assets.a.size" },
    ]);
  });

  it("says the same in the published JSON Schema", () => {
    const schema = JSON.stringify(jsonSchemas()["assets"]);
    const rule = (storage: string, fields: readonly string[]) =>
      JSON.stringify({
        if: { properties: { storage: { const: storage } }, required: ["storage"] },
        // oxlint-disable-next-line unicorn/no-thenable -- it is what JSON Schema calls it
        then: { required: fields },
      });
    expect(schema).toContain('"enum":["git","lfs","local","platform","remote"]');
    expect(schema).not.toContain('"const":"lfs"');
    expect(schema).toContain(rule("platform", ["hash", "size"]));
    expect(schema).toContain(rule("remote", ["url"]));
  });
});

describe("where the file of an asset can be downloaded from", () => {
  const full = { ...base, hash: HASH, size: 3 };

  it("is where it is kept besides here, with its content known to check it by", () => {
    expect(downloadableFrom({ ...full, storage: "lfs" })).toBe("lfs");
    expect(downloadableFrom({ ...full, storage: "platform" })).toBe("platform");
    const url = "https://example.com/a.mp4";
    expect(downloadableFrom({ ...full, storage: "remote", url })).toBe("remote");
  });

  it("is nowhere for a file only here, in the person's own Git, or not known well enough", () => {
    expect(downloadableFrom({ ...full, storage: "local" })).toBeUndefined();
    expect(downloadableFrom({ ...full, storage: "git" })).toBeUndefined();
    expect(downloadableFrom({ ...base, storage: "lfs" })).toBeUndefined();
    expect(downloadableFrom({ ...base, storage: "lfs", hash: HASH })).toBeUndefined();
    expect(downloadableFrom({ ...base, storage: "lfs", size: 3 })).toBeUndefined();
    const url = "https://example.com/a.mp4";
    expect(downloadableFrom({ ...base, storage: "remote", url })).toBeUndefined();
    expect(downloadableFrom({ ...full, storage: "remote" })).toBeUndefined();
  });
});

describe("hashes of files", () => {
  // SHA-256 of nothing at all, as each of them writes it.
  const hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const plain = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";

  it("are the same content however a tool wrote them", () => {
    for (const other of [
      `sha256-${hex}`,
      `sha256-${hex.toUpperCase()}`,
      `sha256-${plain}`,
      `sha256-${plain.slice(0, -1)}`,
      HASH,
    ]) {
      expect(isSameHash(HASH, other), other).toBe(true);
    }
  });

  it("are not the same content when the digest differs, or is no digest at all", () => {
    expect(isSameHash(HASH, "sha256-LCa0a2j_xo_5m0U8HTBBNBNCLXBkg7-g-YpeiGJm564=")).toBe(false);
    expect(isSameHash("sha256-abc", "sha256-abc")).toBe(false);
    expect(isSameHash(`md5-${hex}`, `md5-${hex}`)).toBe(false);
    expect(isSameHash("sha256-!!!", HASH)).toBe(false);
  });
});
