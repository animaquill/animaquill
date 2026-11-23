import { randomBytes } from "node:crypto";
import {
  MIN_PART_BYTES,
  S3Bucket,
  S3Error,
  sha256Base64,
  type S3SignedRequest,
} from "@animaquill/host/s3";
import { beforeAll, describe, expect, test } from "vitest";
import { TEST_S3, testStorageConfig } from "../test/objects.ts";
import { corsRules, LibraryStorage, UPLOAD_HEADERS } from "./storage.ts";

/**
 * The S3 module of the editor (oss/packages/host/src/s3.ts) against a real storage, the versitygw of
 * the deployment, which checks every signature and every checksum: what it signs works, and what
 * differs in any way from what it signed is refused. The rules here are what the cloud space stands
 * on: a browser can only upload exactly what the platform signed an address for.
 */

const EDITOR = "https://editor.example.com";

const bytes = (size: number) => new Uint8Array(randomBytes(size));

/** A request the way a browser makes it from a signed address: its headers, and the body. */
const send = (signed: S3SignedRequest, body?: Uint8Array<ArrayBuffer>, headers = {}) =>
  fetch(signed.url, {
    method: signed.method,
    headers: { ...signed.headers, ...headers },
    ...(body && { body }),
  });

/** What S3 said, as status and code, of an answer that is not ok. */
const refusal = async (response: Response) => {
  const text = await response.text();
  return `${response.status} ${/<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? ""}`.trim();
};

describe.skipIf(!TEST_S3)("the S3 module, against versitygw", () => {
  let storage: LibraryStorage;
  let bucket: S3Bucket;
  beforeAll(async () => {
    storage = new LibraryStorage(testStorageConfig());
    bucket = storage.internal;
    expect(await bucket.headBucket()).toBe(false);
    expect(await bucket.createBucket()).toBe("created");
  });

  test("makes a bucket once, and finds it there then", async () => {
    expect(await bucket.headBucket()).toBe(true);
    expect(await bucket.createBucket()).toBe("existed");
  });

  test("uploads in parts through signed addresses, each part with its checksum, and reads it back", async () => {
    const key = "library/u/upload/whole";
    const uploadId = await bucket.createUpload(key, { checksum: "sha256" });
    const contents = [bytes(MIN_PART_BYTES), bytes(1234)];
    const parts = [];
    for (const [index, content] of contents.entries()) {
      const checksumSha256 = await sha256Base64(content);
      const signed = await storage.public.presignPart(key, uploadId, index + 1, {
        expiresSeconds: 600,
        size: content.byteLength,
        checksumSha256,
      });
      const response = await send(signed, content);
      expect(response.status, await refusal(response.clone())).toBe(200);
      expect(response.headers.get("x-amz-checksum-sha256")).toBe(checksumSha256);
      parts.push({ partNumber: index + 1, etag: response.headers.get("etag")!, checksumSha256 });
    }
    const listed = await bucket.listParts(key, uploadId);
    expect(listed).toEqual(
      parts.map((part, index) => ({ ...part, size: contents[index]!.byteLength })),
    );
    const done = await bucket.completeUpload(key, uploadId, listed);
    expect(done.etag).toMatch(/-2"$/);
    expect(done.checksumSha256).toMatch(/-2$/);
    const head = await bucket.headObject(key);
    expect(head).toMatchObject({
      size: MIN_PART_BYTES + 1234,
      contentType: "application/octet-stream",
      etag: done.etag,
      checksumSha256: done.checksumSha256,
    });
    const read = new Uint8Array(await (await bucket.getObject(key)).arrayBuffer());
    expect(Buffer.from(read).equals(Buffer.concat(contents))).toBe(true);
    // Through an address signed for reading, as a browser reads.
    const signed = await storage.public.presign("GET", key, { expiresSeconds: 60 });
    const got = await send(signed);
    expect(got.status).toBe(200);
    expect(Number(got.headers.get("content-length"))).toBe(MIN_PART_BYTES + 1234);
    await got.body?.cancel();
  });

  test("refuses any part that is not exactly what was signed", async () => {
    const key = "library/u/upload/refused";
    const uploadId = await bucket.createUpload(key, { checksum: "sha256" });
    const content = bytes(4096);
    const checksumSha256 = await sha256Base64(content);
    const signed = await storage.public.presignPart(key, uploadId, 1, {
      expiresSeconds: 600,
      size: content.byteLength,
      checksumSha256,
    });
    const other = bytes(4096);
    // One byte more or less than the size signed in.
    expect(await refusal(await send(signed, bytes(4097)))).toBe("403 SignatureDoesNotMatch");
    expect(await refusal(await send(signed, bytes(4095)))).toBe("403 SignatureDoesNotMatch");
    // Other content of the same size: the storage checks it against the checksum signed in.
    expect(await refusal(await send(signed, other))).toBe("400 BadDigest");
    // Without the checksum, or with that of the other content.
    expect(await refusal(await send({ ...signed, headers: {} }, content))).toBe(
      "403 SignatureDoesNotMatch",
    );
    expect(
      await refusal(
        await send(signed, other, { "x-amz-checksum-sha256": await sha256Base64(other) }),
      ),
    ).toBe("403 SignatureDoesNotMatch");
    // Another part, or another key, than the address is for.
    const otherPart = signed.url.replace("partNumber=1", "partNumber=2");
    expect(await refusal(await send({ ...signed, url: otherPart }, content))).toBe(
      "403 SignatureDoesNotMatch",
    );
    const otherKey = signed.url.replace("/refused?", "/elsewhere?");
    expect(await refusal(await send({ ...signed, url: otherKey }, content))).toBe(
      "403 SignatureDoesNotMatch",
    );
    // None of them left anything.
    expect(await bucket.listParts(key, uploadId)).toEqual([]);
    expect((await send(signed, content)).status).toBe(200);
    expect((await bucket.listParts(key, uploadId)).map((part) => part.partNumber)).toEqual([1]);
    await bucket.abortUpload(key, uploadId);
  });

  test("refuses a single upload that is not what was signed, and keeps what was there", async () => {
    const key = "library/.animaquill-check/single";
    const content = bytes(64);
    const checksumSha256 = await sha256Base64(content);
    const signed = await storage.public.presign("PUT", key, {
      expiresSeconds: 600,
      size: content.byteLength,
      checksumSha256,
    });
    expect(new URL(signed.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host;x-amz-checksum-sha256",
    );
    expect((await send(signed, content)).status).toBe(200);
    expect(await refusal(await send(signed, bytes(64)))).toBe("400 BadDigest");
    const read = new Uint8Array(await (await bucket.getObject(key)).arrayBuffer());
    expect(Buffer.from(read).equals(Buffer.from(content))).toBe(true);
  });

  test("addresses stop working when they expire", async () => {
    const content = bytes(16);
    const signed = await storage.public.presign("PUT", "library/.animaquill-check/late", {
      expiresSeconds: 1,
      size: 16,
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(await refusal(await send(signed, content))).toBe("403 AccessDenied");
  });

  test("signatures are for the host they go to, and made with the right secret only", async () => {
    // Signed for another host than the one the request reaches: as when the platform signs with its
    // own address and a browser goes to the public one.
    const elsewhere = new S3Bucket({
      ...storage.config,
      endpoint: TEST_S3!.replace("127.0.0.1", "localhost"),
    });
    const signed = await elsewhere.presign("GET", "library/.animaquill-check/single", {
      expiresSeconds: 60,
    });
    const sentTo = signed.url.replace("localhost", "127.0.0.1");
    expect(await refusal(await fetch(sentTo))).toBe("403 SignatureDoesNotMatch");
    const wrongSecret = new S3Bucket({
      ...storage.config,
      endpoint: storage.config.endpoint,
      secretAccessKey: "not-the-secret",
    });
    const failed = await wrongSecret.headBucket().catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(S3Error);
    expect(failed).toMatchObject({ status: 403 });
    await expect(wrongSecret.listObjects({ prefix: "" })).rejects.toMatchObject({
      status: 403,
      code: "SignatureDoesNotMatch",
    });
  });

  test("completing needs the parts as they went up, of S3's sizes", async () => {
    const key = "library/u/upload/incomplete";
    const uploadId = await bucket.createUpload(key, { checksum: "none" });
    const small = [bytes(100), bytes(100)];
    const parts = [];
    for (const [index, content] of small.entries()) {
      const response = await send(
        await storage.public.presignPart(key, uploadId, index + 1, {
          expiresSeconds: 60,
          size: content.byteLength,
        }),
        content,
      );
      parts.push({ partNumber: index + 1, etag: response.headers.get("etag")! });
    }
    await expect(
      bucket.completeUpload(key, uploadId, [{ partNumber: 1, etag: '"00000000"' }]),
    ).rejects.toMatchObject({ code: "InvalidPart" });
    // A part before the last one under 5 MiB.
    await expect(bucket.completeUpload(key, uploadId, parts)).rejects.toMatchObject({
      code: "EntityTooSmall",
    });
    expect((await bucket.listUploads({ prefix: "library/u/upload/" })).map((u) => u.key)).toContain(
      key,
    );
    await bucket.abortUpload(key, uploadId);
    await expect(bucket.listParts(key, uploadId)).rejects.toMatchObject({
      status: 404,
      code: "NoSuchUpload",
    });
    // Once more is no failure.
    await bucket.abortUpload(key, uploadId);
    expect(
      (await bucket.listUploads({ prefix: "library/u/upload/" })).map((u) => u.uploadId),
    ).not.toContain(uploadId);
  });

  test("an upload with checksums cannot be completed without them", async () => {
    const key = "library/u/upload/unsummed";
    const uploadId = await bucket.createUpload(key, { checksum: "sha256" });
    const content = bytes(10);
    const response = await send(
      await storage.public.presignPart(key, uploadId, 1, {
        expiresSeconds: 60,
        size: 10,
        checksumSha256: await sha256Base64(content),
      }),
      content,
    );
    await expect(
      bucket.completeUpload(key, uploadId, [
        { partNumber: 1, etag: response.headers.get("etag")! },
      ]),
    ).rejects.toMatchObject({ status: 400 });
    await bucket.abortUpload(key, uploadId);
  });

  test("lists objects a page at a time, and takes them away", async () => {
    for (const name of ["a", "b", "c"]) await bucket.putObject(`library/list/${name}`, name);
    const first = await bucket.listObjects({ prefix: "library/list/", maxKeys: 2 });
    expect(first.objects.map((object) => object.key)).toEqual(["library/list/a", "library/list/b"]);
    expect(first.next).toBeDefined();
    const second = await bucket.listObjects({ prefix: "library/list/", next: first.next });
    expect(second.objects.map((object) => [object.key, object.size])).toEqual([
      ["library/list/c", 1],
    ]);
    expect(second.next).toBeUndefined();
    await bucket.deleteObject("library/list/a");
    await bucket.deleteObject("library/list/a");
    expect(await bucket.headObject("library/list/a")).toBeUndefined();
    await expect(bucket.getObject("library/list/a")).rejects.toMatchObject({
      status: 404,
      code: "NoSuchKey",
    });
  });

  test("keeps the rules for the editor's site, which let its pages upload and read the ETag", async () => {
    expect(await bucket.getCors()).toBeUndefined();
    const rules = corsRules([EDITOR]);
    await bucket.putCors(rules);
    const read = await bucket.getCors();
    expect(read).toHaveLength(1);
    expect(read![0]!.allowedOrigins).toEqual([EDITOR]);
    expect(read![0]!.allowedMethods.toSorted()).toEqual(["GET", "HEAD", "PUT"]);
    expect(read![0]!.allowedHeaders.toSorted()).toEqual([...UPLOAD_HEADERS].toSorted());
    expect(read![0]!.exposeHeaders).toContain("ETag");
    const url = storage.public.url("library/u/cors/x", { partNumber: "1", uploadId: "u" }).href;
    const preflight = (origin: string, headers: string) =>
      fetch(url, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "PUT",
          "access-control-request-headers": headers,
        },
      });
    const allowed = await preflight(EDITOR, "x-amz-checksum-sha256");
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(EDITOR);
    expect(allowed.headers.get("access-control-allow-headers")).toBe("x-amz-checksum-sha256");
    const other = await preflight("https://elsewhere.example", "x-amz-checksum-sha256");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const header = await preflight(EDITOR, "x-amz-meta-anything");
    expect(header.headers.get("access-control-allow-origin")).toBeNull();
    // An upload from the editor's site: the page reads the ETag, which completing needs.
    const content = bytes(8);
    const signed = await storage.public.presign("PUT", "library/u/cors/y", {
      expiresSeconds: 60,
      size: 8,
      checksumSha256: await sha256Base64(content),
    });
    const sent = await send(signed, content, { origin: EDITOR });
    expect(sent.status).toBe(200);
    expect(sent.headers.get("access-control-allow-origin")).toBe(EDITOR);
    expect(sent.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("etag");
  });
});
