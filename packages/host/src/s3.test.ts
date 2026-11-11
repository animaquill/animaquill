import { describe, expect, it } from "vitest";
import {
  COMPLETE_TIMEOUT_MS,
  MAX_PART_BYTES,
  S3Bucket,
  S3Error,
  corsJson,
  corsXml,
  endpointProblem,
  hexToBase64,
  isBucketName,
  isSafeKey,
  isSafePrefix,
  parseXml,
  sha256Base64,
  xmlText,
  type S3Target,
} from "./s3.ts";

/**
 * What can be checked without a service. The platform's tests run all of it against a real one,
 * versitygw, which checks every signature (apps/api/src/library/s3.test.ts in AnimaQuill Cloud).
 */

/** The example of AWS's documentation of signed addresses ("Authenticating Requests: Using Query Parameters"). */
const EXAMPLE: S3Target = {
  endpoint: "https://s3.amazonaws.com",
  region: "us-east-1",
  bucket: "examplebucket",
  pathStyle: false,
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const MAY_24_2013 = () => new Date("2013-05-24T00:00:00Z");

const PATH_STYLE: S3Target = {
  endpoint: "http://storage.test:9000",
  region: "us-east-1",
  bucket: "my-bucket",
  pathStyle: true,
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
};

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** A service that answers what it is told, and remembers what it was asked. */
const service = (answer: (request: Sent) => Response | Promise<Response>) => {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    const request: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body:
        body === undefined || body === null
          ? ""
          : typeof body === "string"
            ? body
            : new TextDecoder().decode(body as Uint8Array),
    };
    sent.push(request);
    return answer(request);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
};

const xml = (text: string, status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/xml" } });

describe("signed addresses", () => {
  it("are what AWS's own example says, to the signature", async () => {
    const bucket = new S3Bucket(EXAMPLE, { now: MAY_24_2013 });
    const { url, headers } = await bucket.presign("GET", "test.txt", { expiresSeconds: 86400 });
    const address = new URL(url);
    expect(address.origin + address.pathname).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt",
    );
    expect(address.searchParams.get("X-Amz-Credential")).toBe(
      "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
    );
    expect(address.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(address.searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(headers).toEqual({});
  });

  it("sign in the size and the checksum of what goes up, and say which header has to go along", async () => {
    const bucket = new S3Bucket(PATH_STYLE, { now: MAY_24_2013 });
    const checksum = await sha256Base64("hello");
    const { url, method, headers } = await bucket.presignPart("library/u/1/abc", "upload-1", 3, {
      expiresSeconds: 3600,
      size: 5,
      checksumSha256: checksum,
    });
    const address = new URL(url);
    expect(method).toBe("PUT");
    expect(address.pathname).toBe("/my-bucket/library/u/1/abc");
    expect(address.searchParams.get("partNumber")).toBe("3");
    expect(address.searchParams.get("uploadId")).toBe("upload-1");
    expect(address.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(address.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;host;x-amz-checksum-sha256",
    );
    // The checksum goes as a header, never in the address.
    expect(url).not.toContain(encodeURIComponent(checksum));
    expect(headers).toEqual({ "x-amz-checksum-sha256": checksum });
    expect(checksum).toBe("LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=");
  });

  it("are refused for what would not work or should not be signed", async () => {
    const bucket = new S3Bucket(PATH_STYLE);
    const part = (options: Parameters<S3Bucket["presignPart"]>[3], number = 1) =>
      bucket.presignPart("a/b", "upload", number, options);
    await expect(part({ expiresSeconds: 0, size: 1 })).rejects.toThrow(RangeError);
    await expect(part({ expiresSeconds: 7 * 24 * 3600 + 1, size: 1 })).rejects.toThrow(RangeError);
    await expect(part({ expiresSeconds: 60, size: MAX_PART_BYTES + 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(part({ expiresSeconds: 60, size: -1 })).rejects.toThrow(RangeError);
    await expect(part({ expiresSeconds: 60, size: 1 }, 0)).rejects.toThrow(RangeError);
    await expect(part({ expiresSeconds: 60, size: 1 }, 10_001)).rejects.toThrow(RangeError);
    await expect(part({ expiresSeconds: 60, size: 1, checksumSha256: "abc" })).rejects.toThrow(
      RangeError,
    );
    await expect(bucket.presign("GET", "a/b", { expiresSeconds: 60, size: 1 })).rejects.toThrow(
      RangeError,
    );
    await expect(bucket.presign("GET", "a/../b", { expiresSeconds: 60 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe("addresses", () => {
  it("are path-style or with the bucket in the host, and say a name without a value as itself", () => {
    const path = new S3Bucket(PATH_STYLE);
    expect(path.url().href).toBe("http://storage.test:9000/my-bucket");
    expect(path.url(undefined, { cors: "" }).href).toBe("http://storage.test:9000/my-bucket?cors");
    expect(path.url("library/x", { uploadId: "a b+c", partNumber: "2" }).href).toBe(
      "http://storage.test:9000/my-bucket/library/x?uploadId=a%20b%2Bc&partNumber=2",
    );
    const host = new S3Bucket(EXAMPLE);
    expect(host.url("library/x").href).toBe("https://examplebucket.s3.amazonaws.com/library/x");
    expect(host.url().href).toBe("https://examplebucket.s3.amazonaws.com/");
  });

  it("take only keys every service reads the same", () => {
    for (const key of ["a", "library/u/0190-ab/9f86d0", "x.y_z-1/2", "a/b.c"])
      expect(isSafeKey(key), key).toBe(true);
    for (const key of [
      "",
      "/a",
      "a/",
      "a//b",
      "./a",
      "a/../b",
      "..",
      "a b",
      "a+b",
      "a%2Fb",
      "ä",
      "a?b",
      "a#b",
      "x".repeat(1025),
    ])
      expect(isSafeKey(key), key).toBe(false);
    expect(isSafePrefix("")).toBe(true);
    expect(isSafePrefix("library/")).toBe(true);
    expect(isSafePrefix("a/b/")).toBe(true);
    expect(isSafePrefix("library")).toBe(false);
    expect(isSafePrefix("/")).toBe(false);
    expect(isSafePrefix("a//")).toBe(false);
  });

  it("are for buckets, regions and services that are what S3 has", () => {
    expect(isBucketName("my-bucket")).toBe(true);
    expect(isBucketName("a.b-c")).toBe(true);
    for (const name of [
      "ab",
      "A-bucket",
      "-ab",
      "ab-",
      "a..b",
      "192.168.1.1",
      "a_b",
      "x".repeat(64),
    ])
      expect(isBucketName(name), name).toBe(false);
    expect(endpointProblem("https://objects.example")).toBeUndefined();
    expect(endpointProblem("http://storage.test:9000/")).toBeUndefined();
    expect(endpointProblem("ftp://x")).toBeDefined();
    expect(endpointProblem("https://x/path")).toBeDefined();
    expect(endpointProblem("https://user:pw@x")).toBeDefined();
    expect(endpointProblem("https://x?a=1")).toBeDefined();
    expect(endpointProblem("nothing")).toBeDefined();
    expect(() => new S3Bucket({ ...PATH_STYLE, region: "US East" })).toThrow(RangeError);
    expect(() => new S3Bucket({ ...PATH_STYLE, bucket: "Nope" })).toThrow(RangeError);
    expect(() => new S3Bucket({ ...PATH_STYLE, endpoint: "https://x/p" })).toThrow(RangeError);
    expect(() => new S3Bucket({ ...PATH_STYLE, accessKeyId: "a/b" })).toThrow(RangeError);
    expect(() => new S3Bucket({ ...EXAMPLE, bucket: "with.dots" })).toThrow(RangeError);
    expect(new S3Bucket({ ...PATH_STYLE, bucket: "with.dots" }).bucket).toBe("with.dots");
  });
});

describe("XML", () => {
  it("reads what storage answers, entities and all", () => {
    // ListParts, as versitygw answers it: quotes of the ETag as &#34;.
    const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>b</Bucket><IsTruncated>true</IsTruncated><Part><PartNumber>1</PartNumber><ETag>&#34;71bbf3ba&#34;</ETag><Size>5242880</Size></Part><!-- a comment --><Part><PartNumber>2</PartNumber><ETag>&quot;x&amp;y&lt;&gt;&apos;&#x41;&quot;</ETag><Empty/></Part></ListPartsResult>`);
    expect(root.name).toBe("ListPartsResult");
    expect(xmlText(root, "IsTruncated")).toBe("true");
    const parts = root.children.filter((child) => child.name === "Part");
    expect(parts.map((part) => xmlText(part, "ETag"))).toEqual(['"71bbf3ba"', `"x&y<>'A"`]);
    expect(xmlText(parts[1]!, "Empty")).toBe("");
    expect(parseXml("<a><b><![CDATA[<not a tag> & such]]></b></a>").children[0]!.text).toBe(
      "<not a tag> & such",
    );
    expect(parseXml(`<s3:Error xmlns:s3="x"><s3:Code>NoSuchKey</s3:Code></s3:Error>`).name).toBe(
      "Error",
    );
    expect(parseXml(`<a href="x>y">z</a>`).text).toBe("z");
  });

  it("refuses what is not an answer of storage, and never expands anything", () => {
    for (const text of [
      "",
      "plain",
      "<a>",
      "<a></b>",
      "<a/><b/>",
      "<a>x</a>trailing",
      "<a>&unknown;</a>",
      "<a>AT&T</a>",
      "<a>&#xD800;</a>",
      `<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`,
      "<a><!-- open </a>",
      `<a>${"<b>".repeat(40)}${"</b>".repeat(40)}</a>`,
    ])
      expect(() => parseXml(text), text).toThrow(SyntaxError);
  });

  it("writes rules that read back as they were, and as JSON for consoles", async () => {
    const rules = [
      {
        allowedOrigins: ["https://app.example"],
        allowedMethods: ["PUT", "GET"],
        allowedHeaders: ["x-amz-checksum-sha256"],
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 3600,
      },
      {
        allowedOrigins: ["https://a<b>&c"],
        allowedMethods: ["HEAD"],
        allowedHeaders: [],
        exposeHeaders: [],
      },
    ];
    const { fetch } = service(() => xml(corsXml(rules)));
    expect(await new S3Bucket(PATH_STYLE, { fetch }).getCors()).toEqual(rules);
    expect(JSON.parse(corsJson(rules))).toEqual([
      {
        AllowedOrigins: ["https://app.example"],
        AllowedMethods: ["PUT", "GET"],
        AllowedHeaders: ["x-amz-checksum-sha256"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3600,
      },
      {
        AllowedOrigins: ["https://a<b>&c"],
        AllowedMethods: ["HEAD"],
        AllowedHeaders: [],
        ExposeHeaders: [],
      },
    ]);
  });
});

describe("operations", () => {
  it("sign their headers and the hash of what they send", async () => {
    const { sent, fetch } = service(() => new Response(null, { status: 200 }));
    const bucket = new S3Bucket(PATH_STYLE, { fetch, now: MAY_24_2013 });
    await bucket.putObject("library/.check", "hello");
    const [put] = sent;
    expect(put!.method).toBe("PUT");
    expect(put!.body).toBe("hello");
    expect(put!.headers.get("x-amz-content-sha256")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(put!.headers.get("x-amz-checksum-sha256")).toBe(await sha256Base64("hello"));
    expect(put!.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=test-key\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it("complete with the parts in order, and fail on an error that came with 200", async () => {
    const { sent, fetch } = service(({ url }) =>
      url.includes("uploadId=bad")
        ? xml(`<Error><Code>InternalError</Code><Message>try again</Message></Error>`)
        : xml(
            `<CompleteMultipartUploadResult><ETag>&#34;abc-2&#34;</ETag><ChecksumSHA256>x=-2</ChecksumSHA256></CompleteMultipartUploadResult>`,
          ),
    );
    const bucket = new S3Bucket(PATH_STYLE, { fetch });
    const checksum = await sha256Base64("a");
    const parts = [
      { partNumber: 2, etag: '"two"', checksumSha256: checksum },
      { partNumber: 1, etag: '"one"', checksumSha256: checksum },
    ];
    expect(await bucket.completeUpload("k/1", "good", parts)).toEqual({
      etag: '"abc-2"',
      checksumSha256: "x=-2",
    });
    expect(sent[0]!.body).toBe(
      `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><PartNumber>1</PartNumber><ETag>&quot;one&quot;</ETag><ChecksumSHA256>${checksum}</ChecksumSHA256></Part><Part><PartNumber>2</PartNumber><ETag>&quot;two&quot;</ETag><ChecksumSHA256>${checksum}</ChecksumSHA256></Part></CompleteMultipartUpload>`,
    );
    const failed = await bucket
      .completeUpload("k/1", "bad", parts)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(S3Error);
    expect(failed).toMatchObject({
      status: 200,
      code: "InternalError",
      operation: "completeUpload",
    });
    await expect(bucket.completeUpload("k/1", "good", [parts[0]!, parts[0]!])).rejects.toThrow(
      RangeError,
    );
    await expect(bucket.completeUpload("k/1", "good", [])).rejects.toThrow(RangeError);
    expect(COMPLETE_TIMEOUT_MS).toBeGreaterThan(60_000);
  });

  it("list every page of parts, and stop at one that does not go further", async () => {
    const page = (marker: string | null) =>
      marker === null
        ? `<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>1</NextPartNumberMarker><Part><PartNumber>1</PartNumber><ETag>"a"</ETag><Size>5</Size><ChecksumSHA256>c1</ChecksumSHA256></Part></ListPartsResult>`
        : `<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>2</PartNumber><ETag>"b"</ETag><Size>3</Size></Part></ListPartsResult>`;
    const { sent, fetch } = service(({ url }) =>
      xml(page(new URL(url).searchParams.get("part-number-marker"))),
    );
    const bucket = new S3Bucket(PATH_STYLE, { fetch });
    expect(await bucket.listParts("k", "u")).toEqual([
      { partNumber: 1, etag: '"a"', size: 5, checksumSha256: "c1" },
      { partNumber: 2, etag: '"b"', size: 3, checksumSha256: undefined },
    ]);
    expect(sent.map(({ url }) => new URL(url).search)).toEqual([
      "?uploadId=u",
      "?uploadId=u&part-number-marker=1",
    ]);
    const stuck = service(() =>
      xml(
        `<ListPartsResult><IsTruncated>true</IsTruncated><NextPartNumberMarker>0</NextPartNumberMarker></ListPartsResult>`,
      ),
    );
    await expect(
      new S3Bucket(PATH_STYLE, { fetch: stuck.fetch }).listParts("k", "u"),
    ).rejects.toMatchObject({ code: "BadAnswer" });
  });

  it("say what is not there as undefined, and the rest as S3Error without anything secret", async () => {
    const { fetch } = service(({ url, method }) => {
      if (method === "HEAD")
        return new Response(null, { status: url.includes("gone") ? 404 : 403 });
      if (url.endsWith("?cors"))
        return xml(`<Error><Code>NoSuchCORSConfiguration</Code></Error>`, 404);
      return xml(
        `<Error><Code>SignatureDoesNotMatch</Code><Message>no</Message><StringToSign>AWS4-HMAC-SHA256 secret-ish</StringToSign><AWSAccessKeyId>test-key</AWSAccessKeyId></Error>`,
        403,
      );
    });
    const bucket = new S3Bucket(PATH_STYLE, { fetch });
    expect(await bucket.headObject("gone")).toBeUndefined();
    expect(await bucket.getCors()).toBeUndefined();
    await expect(bucket.headObject("here")).rejects.toMatchObject({
      status: 403,
      code: "HTTP 403",
    });
    const failed = (await bucket
      .listObjects({ prefix: "library/" })
      .catch((error: unknown) => error)) as S3Error;
    expect(failed).toMatchObject({ status: 403, code: "SignatureDoesNotMatch" });
    expect(failed.message).not.toContain("StringToSign");
    expect(failed.message).not.toContain("secret");
  });

  it("say when no answer came, or one that sends the request elsewhere", async () => {
    const down = service(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      new S3Bucket(PATH_STYLE, { fetch: down.fetch }).headBucket(),
    ).rejects.toMatchObject({
      status: 0,
      code: "Unreachable",
    });
    const slow = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof globalThis.fetch;
    await expect(
      new S3Bucket(PATH_STYLE, { fetch: slow, timeoutMs: 20 }).headBucket(),
    ).rejects.toMatchObject({ code: "Timeout" });
    const asked = new AbortController();
    const waiting = new S3Bucket(PATH_STYLE, { fetch: slow }).getObject("a", {
      signal: asked.signal,
    });
    asked.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
    const moved = service(
      () => new Response(null, { status: 301, headers: { location: "https://elsewhere" } }),
    );
    await expect(
      new S3Bucket(PATH_STYLE, { fetch: moved.fetch }).headBucket(),
    ).rejects.toMatchObject({ code: "Redirect" });
  });

  it("take an existing bucket and an upload that is gone as done", async () => {
    const { fetch } = service(({ method }) =>
      method === "PUT"
        ? xml(`<Error><Code>BucketAlreadyOwnedByYou</Code></Error>`, 409)
        : xml(`<Error><Code>NoSuchUpload</Code></Error>`, 404),
    );
    const bucket = new S3Bucket(PATH_STYLE, { fetch });
    expect(await bucket.createBucket()).toBe("existed");
    await expect(bucket.abortUpload("k", "u")).resolves.toBeUndefined();
    const taken = service(() => xml(`<Error><Code>BucketAlreadyExists</Code></Error>`, 409));
    await expect(
      new S3Bucket(PATH_STYLE, { fetch: taken.fetch }).createBucket(),
    ).rejects.toMatchObject({
      code: "BucketAlreadyExists",
    });
  });
});

describe("checksums", () => {
  it("are base64 of SHA-256, from text, bytes or hexadecimal", async () => {
    const hex = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    expect(await sha256Base64("hello")).toBe(hexToBase64(hex));
    expect(await sha256Base64(new TextEncoder().encode("hello"))).toBe(hexToBase64(hex));
    expect(() => hexToBase64("xyz")).toThrow(RangeError);
  });
});
