import { describe, expect, test } from "vitest";
import { CloudSignedOut, LfsRefused } from "./index.ts";
import { browserLfs, uploadOf } from "./lfs.ts";

/** Sending files into the large file storage of a repository through a platform's API. */

interface Sent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const platform = (answer: (sent: Sent) => Response) => {
  const sent: Sent[] = [];
  const access = browserLfs({
    api: (path) => `https://platform.example/api${path}`,
    changeHeaders: { "x-animaquill": "1" },
    fetch: async (input, init) => {
      const body = init?.body;
      const request = {
        url: String(input),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        body:
          typeof body === "string"
            ? JSON.parse(body)
            : body instanceof Blob
              ? new Uint8Array(await body.arrayBuffer())
              : undefined,
      };
      sent.push(request);
      return answer(request);
    },
  });
  return { access, sent };
};

const OID = "a".repeat(64);
const UPLOAD = {
  id: "0190a6b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b",
  state: "receiving",
  repo: "123456",
  oid: OID,
  size: 10,
  received: 4,
  chunk: 8 * 1024 * 1024,
  minChunk: 64 * 1024,
  somethingNew: true,
};

describe("the large file storage through the platform", () => {
  test("asks the platform's API, and sends what changes something with its headers", async () => {
    const { access, sent } = platform(({ method }) =>
      method === "DELETE" ? new Response(null, { status: 204 }) : Response.json(UPLOAD),
    );
    expect(await access.begin("p/1", { oid: OID, size: 10 })).toEqual({
      id: UPLOAD.id,
      state: "receiving",
      repo: "123456",
      oid: OID,
      size: 10,
      received: 4,
      chunk: 8 * 1024 * 1024,
      minChunk: 64 * 1024,
    });
    await access.send(UPLOAD.id, 4, new Blob([new Uint8Array([1, 2, 3])]));
    await access.state(UPLOAD.id);
    await access.cancel(UPLOAD.id);
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      "POST https://platform.example/api/projects/p%2F1/lfs/objects",
      `PUT https://platform.example/api/lfs/uploads/${UPLOAD.id}`,
      `GET https://platform.example/api/lfs/uploads/${UPLOAD.id}`,
      `DELETE https://platform.example/api/lfs/uploads/${UPLOAD.id}`,
    ]);
    expect(sent[0]!.body).toEqual({ oid: OID, size: 10 });
    expect(sent[0]!.headers).toMatchObject({
      "x-animaquill": "1",
      "content-type": "application/json",
    });
    expect(sent[1]!.headers).toEqual({
      "x-animaquill": "1",
      "content-type": "application/octet-stream",
      "upload-offset": "4",
    });
    expect(sent[1]!.body).toEqual(new Uint8Array([1, 2, 3]));
    expect(sent[2]!.headers).toEqual({});
    expect(sent[3]!.headers).toEqual({ "x-animaquill": "1" });
    expect(sent[3]!.body).toBeUndefined();
  });

  test("a file the storage has already is there, with nothing to send", async () => {
    const { access } = platform(() =>
      Response.json({ state: "present", repo: "123456", oid: OID, size: 10 }),
    );
    expect(await access.begin("p1", { oid: OID, size: 10 })).toEqual({
      state: "present",
      repo: "123456",
      oid: OID,
      size: 10,
      received: 0,
      chunk: 0,
      minChunk: 0,
    });
  });

  test("an upload that failed says why, in the platform's words", async () => {
    const { access } = platform(() =>
      Response.json({ ...UPLOAD, state: "failed", error: "changed", detail: "a few words" }),
    );
    expect(await access.state(UPLOAD.id)).toMatchObject({
      state: "failed",
      error: "changed",
      detail: "a few words",
    });
  });

  test("refusals come with their code, where the next piece goes, and how long to wait", async () => {
    const answers: Response[] = [
      Response.json({ error: "offset", received: 8 }, { status: 409 }),
      Response.json({ error: "busy" }, { status: 503, headers: { "retry-after": "30" } }),
      Response.json({ error: "githubQuota", detail: "over its data quota" }, { status: 409 }),
      Response.json({ error: "signedOut" }, { status: 401 }),
      new Response("Request Entity Too Large", { status: 413 }),
      new Response("Bad Gateway", { status: 502 }),
    ];
    const { access } = platform(() => answers.shift()!);
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(await refusal(access.send(UPLOAD.id, 4, new Blob(["x"])))).toMatchObject({
      code: "offset",
      received: 8,
    });
    const busy = await refusal(access.begin("p1", { oid: OID, size: 10 }));
    expect(busy).toBeInstanceOf(LfsRefused);
    expect(busy).toMatchObject({ code: "busy", retryAfter: 30 });
    expect(await refusal(access.begin("p1", { oid: OID, size: 10 }))).toMatchObject({
      code: "githubQuota",
      detail: "over its data quota",
    });
    expect(await refusal(access.state(UPLOAD.id))).toBeInstanceOf(CloudSignedOut);
    // From the gateway, which says no to a piece that is too large before the platform sees it.
    expect(await refusal(access.send(UPLOAD.id, 4, new Blob(["x"])))).toMatchObject({
      code: "tooLarge",
    });
    expect(await refusal(access.state(UPLOAD.id))).toMatchObject({ code: "unavailable" });
  });

  test("what cannot go well the next time either is not 'unavailable': a 403, whoever says it, and an answer that is no upload", async () => {
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => undefined,
        (error: unknown) => error,
      );
    const answers: Response[] = [
      // The platform, to a page that is not its own.
      Response.json({ error: "forbidden" }, { status: 403 }),
      // Something in front of it, in words of its own.
      new Response("<html>Forbidden</html>", { status: 403 }),
      // A piece that took too long, as the platform says it, and as its server does without a word.
      Response.json({ error: "slow" }, { status: 408 }),
      new Response(null, { status: 408 }),
    ];
    const { access } = platform(() => answers.shift()!);
    for (const code of ["forbidden", "forbidden", "slow", "slow"]) {
      const refused = await refusal(access.send(UPLOAD.id, 4, new Blob(["x"])));
      expect(refused).toBeInstanceOf(LfsRefused);
      expect(refused).toMatchObject({ code });
    }
    // It says it went well, and what it says is no upload: a page of something in between, JSON
    // of something else, nothing at all.
    const wrong: Response[] = [
      new Response("<html>Sign in to the network</html>", { status: 200 }),
      Response.json({ ok: true }),
      Response.json({ ...UPLOAD, state: "somethingNew" }),
      new Response(null, { status: 200 }),
    ];
    const other = platform(() => wrong.shift()!);
    for (const ask of [
      () => other.access.begin("p1", { oid: OID, size: 10 }),
      () => other.access.send(UPLOAD.id, 4, new Blob(["x"])),
      () => other.access.state(UPLOAD.id),
      () => other.access.state(UPLOAD.id),
    ]) {
      const refused = await refusal(ask());
      expect(refused).toBeInstanceOf(LfsRefused);
      expect(refused).toMatchObject({ code: "malformed" });
    }
  });

  test("no answer at all is 'unavailable'; a piece given up on is given up on", async () => {
    const offline = browserLfs({
      api: (path) => path,
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(offline.state(UPLOAD.id)).rejects.toMatchObject({ code: "unavailable" });
    const stopped = new AbortController();
    const waiting = browserLfs({
      api: (path) => path,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    });
    const sending = waiting.send(UPLOAD.id, 0, new Blob(["x"]), { signal: stopped.signal });
    stopped.abort(new DOMException("stopped", "AbortError"));
    await expect(sending).rejects.toMatchObject({ name: "AbortError" });
  });

  test("reads what the platform says field by field, and nothing that is not an upload", () => {
    expect(uploadOf({ ...UPLOAD, received: 99, error: 3 })).toMatchObject({
      received: 10,
    });
    expect(uploadOf({ ...UPLOAD, error: 3 })).not.toHaveProperty("error");
    for (const wrong of [
      null,
      [],
      { ...UPLOAD, state: "unknown" },
      { ...UPLOAD, repo: 123456 },
      { ...UPLOAD, size: -1 },
      { ...UPLOAD, id: undefined },
    ])
      expect(() => uploadOf(wrong), JSON.stringify(wrong)).toThrow(LfsRefused);
  });
});
