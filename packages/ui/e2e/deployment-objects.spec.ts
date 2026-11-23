import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { S3Bucket, sha256Base64, type S3SignedRequest } from "@animaquill/host/s3";
import type { Page } from "@playwright/test";
import { expect, test } from "./support.ts";

/**
 * The object storage of the cloud space on the real sites, through the gateway (deploy/stacks/objects,
 * docs/design/phase5-step14.md 3.3): pages of the editor upload and read with addresses the platform
 * signs, through the gateway's objects.animaquill.dev, and nothing else gets through. The storage is
 * versitygw, which scripts/e2e-edge runs; run.sh gives the API its settings, and these tests sign
 * with the same key, as the platform does.
 */

const EDITOR = "https://app.animaquill.com";
const OBJECTS = "https://objects.animaquill.dev";
/** The authority the gateway's certificates come from in here, see run.sh. */
const GATEWAY_CA = "/tmp/caddy-gateway/pki/authorities/local/root.crt";

/** The command line of the server, as whoever runs it uses it, trusting the gateway in here. */
const command = (...args: string[]) =>
  execFileSync("node", ["/work/apps/api/src/admin.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: GATEWAY_CA },
  });

/** The bucket as browsers reach it, signed for as the platform signs. */
const publicBucket = () =>
  new S3Bucket({
    endpoint: OBJECTS,
    region: "us-east-1",
    bucket: process.env["LIBRARY_S3_BUCKET"]!,
    pathStyle: true,
    accessKeyId: process.env["LIBRARY_S3_ACCESS_KEY_ID"]!,
    secretAccessKey: process.env["LIBRARY_S3_SECRET_ACCESS_KEY"]!,
  });

const keyOf = (name: string) => `library/u/edge-test/${name}-${randomBytes(4).toString("hex")}`;

/** Refused requests show in the console as errors, which is what these tests are about. */
const refusedInConsole = (problems: string[]) => {
  const left = problems.filter(
    (problem) =>
      !/Failed to load resource: the server responded with a status of 40[03]/.test(problem),
  );
  problems.splice(0, problems.length, ...left);
};

/** A PUT from the page, as the editor will make it: the status, and the ETag when it can read it. */
const putFrom = (page: Page, signed: S3SignedRequest, bytes: readonly number[]) =>
  page.evaluate(
    async ({ signed, bytes }) => {
      try {
        const response = await fetch(signed.url, {
          method: "PUT",
          headers: signed.headers,
          body: new Uint8Array(bytes),
        });
        return { status: response.status, etag: response.headers.get("etag") };
      } catch (error) {
        return { failed: String(error) };
      }
    },
    { signed, bytes },
  );

test.use({ withProject: false });

test.beforeAll(() => {
  // Made ready as on the server: the bucket, the rules for the editor's site, the sentinel.
  expect(command("storage", "setup")).toContain("准备好了");
});

test("the storage check passes through the gateway, as browsers reach the storage", () => {
  const said = command("storage", "check");
  expect(said).toContain(`[通过] 跨域预检：${OBJECTS} 允许 ${EDITOR} 上传`);
  expect(said).toContain(`[通过] 签名上传和读取：经 ${OBJECTS} 用签名地址上传`);
  expect(said).toContain("[通过] 校验值");
  expect(said.trim().split("\n").at(-1)).toBe("全部通过。");
});

test("the editor's page uploads and reads with signed addresses, and reads the ETag", async ({
  page,
}) => {
  expect(new URL(page.url()).origin).toBe(EDITOR);
  const bucket = publicBucket();
  const content = randomBytes(1000);
  const key = keyOf("upload");
  const put = await bucket.presign("PUT", key, {
    expiresSeconds: 300,
    size: content.length,
    checksumSha256: await sha256Base64(new Uint8Array(content)),
  });
  const get = await bucket.presign("GET", key, { expiresSeconds: 300 });
  const sent = await putFrom(page, put, [...content]);
  expect(sent).toEqual({ status: 200, etag: expect.stringMatching(/^"[0-9a-f]{32}"$/) });
  const read = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      status: response.status,
      bytes: [...new Uint8Array(await response.arrayBuffer())],
      encoding: response.headers.get("content-encoding"),
    };
  }, get.url);
  expect(read.status).toBe(200);
  expect(Buffer.from(read.bytes).equals(content)).toBe(true);
  expect(read.encoding).toBeNull();
});

test("what was not signed is refused, the editor hears why, and a page of no site gets nowhere", async ({
  page,
  problems,
}) => {
  const bucket = publicBucket();
  const content = randomBytes(64);
  const put = await bucket.presign("PUT", keyOf("refused"), {
    expiresSeconds: 300,
    size: content.length,
    checksumSha256: await sha256Base64(new Uint8Array(content)),
  });
  // Other content of the size signed in, and one byte more: the page reads why, to say so.
  expect(await putFrom(page, put, [...randomBytes(64)])).toEqual({ status: 400, etag: null });
  expect(await putFrom(page, put, [...randomBytes(65)])).toEqual({ status: 403, etag: null });
  refusedInConsole(problems);
  // A page of no site (about:blank, whose origin is null), with an address that works, gets nowhere:
  // the storage lets only the editor's site in. No routes on that page: they would answer the
  // browser's preflight in place of the storage.
  const nowhere = await page.context().newPage();
  expect(await putFrom(nowhere, put, [...content])).toEqual({
    failed: expect.stringContaining("TypeError"),
  });
  await nowhere.close();
  // The address itself was fine all along.
  expect(await putFrom(page, put, [...content])).toMatchObject({ status: 200 });
});

test("every answer of the storage is a sandbox, unnamed, and as stored", async ({ request }) => {
  const health = await request.get(`${OBJECTS}/_/health`);
  expect(health.status()).toBe(200);
  const headers = health.headers();
  expect(headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["strict-transport-security"]).toBeTruthy();
  expect(headers["server"]).toBeUndefined();
  // A page of text and markup, stored, comes back as stored, uncompressed, and never as a page.
  const bucket = publicBucket();
  const key = keyOf("page");
  const markup = Buffer.from(
    `<html><script>parent.postMessage("ran", "*")</script>${"x".repeat(4000)}</html>`,
  );
  const put = await bucket.presign("PUT", key, { expiresSeconds: 300, size: markup.length });
  expect((await request.put(put.url, { data: markup })).status()).toBe(200);
  const get = await bucket.presign("GET", key, { expiresSeconds: 300 });
  const read = await request.get(get.url, { headers: { "accept-encoding": "gzip, br, zstd" } });
  expect(read.status()).toBe(200);
  expect(read.headers()["content-encoding"]).toBeUndefined();
  expect(read.headers()["content-security-policy"]).toBe("sandbox; default-src 'none'");
  expect(Buffer.from(await read.body()).equals(markup)).toBe(true);
});
