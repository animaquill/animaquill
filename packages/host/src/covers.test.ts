import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { projectSummaryOf } from "./cloud-projects.ts";
import { browserCoverAccess, browserCoverStore, type CoverChannel } from "./covers.ts";
import { COVER_BYTES, CloudSignedOut, coverEtag, type ProjectCover } from "./index.ts";

/** Windows of one browser: what one posts, the others hear. */
function browserOf() {
  const factory = new IDBFactory();
  const windows = new Set<(key: string) => void>();
  const channel = (): CoverChannel => {
    let own: ((key: string) => void) | undefined;
    return {
      post: (key) => {
        for (const listener of windows) if (listener !== own) listener(key);
      },
      listen(listener) {
        own = listener;
        windows.add(listener);
        return () => windows.delete(listener);
      },
    };
  };
  return () => browserCoverStore(() => factory, channel);
}

const webp = (text: string) => new Blob([text], { type: "image/webp" });
const cover = (etag: string, more: Partial<ProjectCover> = {}): ProjectCover => ({
  picture: webp(etag),
  at: 1,
  etag,
  ...more,
});

describe("the covers of a browser", () => {
  it("keeps one for each project, which every window reads and hears of", async () => {
    const windowOf = browserOf();
    const one = windowOf();
    const other = windowOf();
    const heard: string[] = [];
    other.listen((key) => heard.push(key));
    await one.put("folder-1", cover("a", { durationMs: 4200, made: "v1" }));
    const read = await other.read(["folder-1", "folder-2"]);
    expect([...read.keys()]).toEqual(["folder-1"]);
    expect(read.get("folder-1")).toMatchObject({ etag: "a", durationMs: 4200, made: "v1" });
    expect(await read.get("folder-1")?.picture.text()).toBe("a");
    expect(heard).toEqual(["folder-1"]);
    await other.forget("folder-1");
    expect((await one.read(["folder-1"])).size).toBe(0);
  });

  it("notes what the platform took only while that is still the cover kept", async () => {
    const store = browserOf()();
    await store.put("p", cover("a"));
    await store.put("p", cover("b"));
    // What was sent was "a": "b" came meanwhile, and still has to go.
    await store.sent("p", "a");
    expect((await store.read(["p"])).get("p")?.sent).toBeUndefined();
    await store.sent("p", "b");
    expect((await store.read(["p"])).get("p")?.sent).toBe("b");
  });

  it("keeps what the editor made in place of its own, but not of one people chose", async () => {
    const store = browserOf()();
    await store.put("p", cover("a", { sent: "a" }));
    // The same picture: what was sent stays sent.
    expect(await store.made("p", cover("a", { at: 2, made: "v2" }))).toMatchObject({
      etag: "a",
      sent: "a",
      made: "v2",
    });
    expect(await store.made("p", cover("b", { at: 3, durationMs: 10 }))).toMatchObject({
      etag: "b",
      sent: "a",
      durationMs: 10,
    });
    await store.put("p", cover("mine", { chosen: true, sent: "mine" }));
    const kept = await store.made("p", cover("c", { at: 4, durationMs: 20, made: "v4" }));
    expect(kept).toMatchObject({ etag: "mine", chosen: true, sent: "mine", durationMs: 20 });
    expect(kept.auto?.etag).toBe("c");
    expect((await store.read(["p"])).get("p")).toMatchObject({ etag: "mine", made: "v4" });
    expect(await (await store.read(["p"])).get("p")?.auto?.picture.text()).toBe("c");
  });

  it("knows a picture by what the platform says of it", async () => {
    // The start of the SHA-256 of "abc", base64url, as apps/api/src/sync/covers.ts makes it.
    expect(await coverEtag(new Blob(["abc"]))).toBe("ungWv48Bz-pBQUDeXa4iI7");
  });
});

const answer = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("the covers of a platform", () => {
  const accessWith = (respond: (url: string, init?: RequestInit) => Response) => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      respond(String(input), init),
    );
    return {
      fetch,
      access: browserCoverAccess({
        api: (path) => `/api${path}`,
        changeHeaders: { "x-animaquill": "1" },
        fetch: fetch as typeof globalThis.fetch,
      }),
    };
  };

  it("sends a picture with how long the main timeline is, and what the platform knows it by", async () => {
    const { access, fetch } = accessWith(() => answer(200, { etag: "e1", at: 5 }));
    expect(await access.put("p_1", webp("x"), 4200.4)).toEqual({ kind: "kept", etag: "e1", at: 5 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/projects/p_1/cover?durationMs=4200");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ "x-animaquill": "1", "content-type": "image/webp" });
  });

  it("says when to send again, and what never goes", async () => {
    const busy = accessWith(() => answer(429, { error: "busy" }, { "retry-after": "42" }));
    expect(await busy.access.put("p", webp("x"), undefined)).toEqual({
      kind: "busy",
      retryAfterMs: 42_000,
    });
    const missing = accessWith(() => answer(404, { error: "notFound" }));
    expect(await missing.access.put("p", webp("x"), undefined)).toEqual({ kind: "missing" });
    const large = accessWith(() => answer(413, { error: "tooLarge" }));
    expect(await large.access.put("p", webp("x"), undefined)).toEqual({ kind: "refused" });
    // Too large or of another type is not even asked about.
    const unasked = accessWith(() => answer(200, { etag: "e", at: 1 }));
    expect(await unasked.access.put("p", new Blob(["x"], { type: "image/png" }), 1)).toEqual({
      kind: "refused",
    });
    expect(
      await unasked.access.put(
        "p",
        new Blob([new Uint8Array(COVER_BYTES + 1)], { type: "image/jpeg" }),
        1,
      ),
    ).toEqual({ kind: "refused" });
    expect(unasked.fetch).not.toHaveBeenCalled();
  });

  it("takes only the platform's own words for an answer", async () => {
    const out = accessWith(() => answer(401, { error: "signedOut" }));
    await expect(out.access.put("p", webp("x"), 1)).rejects.toBeInstanceOf(CloudSignedOut);
    // A gateway's 404 is no "not there".
    const gateway = accessWith(() => new Response("<html>", { status: 404 }));
    await expect(gateway.access.put("p", webp("x"), 1)).rejects.toThrow();
    await expect(gateway.access.get("p")).rejects.toThrow();
    // Nor is a page a picture.
    const page = accessWith(
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    await expect(page.access.get("p")).rejects.toThrow();
  });

  it("fetches a picture, or says there is none", async () => {
    const there = accessWith(
      () => new Response("pic", { status: 200, headers: { "content-type": "image/jpeg" } }),
    );
    const picture = await there.access.get("p_1");
    expect(picture?.type).toBe("image/jpeg");
    expect(await picture?.text()).toBe("pic");
    expect(there.fetch.mock.calls[0]![0]).toBe("/api/projects/p_1/cover");
    const none = accessWith(() => answer(404, { error: "notFound" }));
    expect(await none.access.get("p_1")).toBeUndefined();
  });

  it("says how long the timeline is without a picture", async () => {
    const kept = accessWith(() => new Response(null, { status: 204 }));
    expect(await kept.access.duration("p_1", 4200.4)).toBe("kept");
    const [url, init] = kept.fetch.mock.calls[0]!;
    expect(url).toBe("/api/projects/p_1/cover?durationMs=4200");
    expect(init?.method).toBe("PATCH");
    expect(init?.body).toBeUndefined();
    const busy = accessWith(() => answer(429, { error: "busy" }, { "retry-after": "30" }));
    expect(await busy.access.duration("p_1", 1)).toEqual({ busy: 30_000 });
    const none = accessWith(() => answer(404, { error: "notFound" }));
    expect(await none.access.duration("p_1", 1)).toBe("missing");
  });

  it("reads the cover and the length of a project in the list", () => {
    const listed = projectSummaryOf({
      id: "p_1",
      name: "a",
      updatedAt: 1,
      cover: { etag: "ungWv48Bz-pBQUDeXa4iI7", at: 9 },
      durationMs: 4200,
    });
    expect(listed).toMatchObject({
      cover: { etag: "ungWv48Bz-pBQUDeXa4iI7", at: 9 },
      durationMs: 4200,
    });
    // An etag goes into a key and a request: only what the platform makes.
    const odd = projectSummaryOf({
      id: "p_1",
      name: "a",
      updatedAt: 1,
      cover: { etag: "../x", at: 9 },
      durationMs: -1,
    });
    expect(odd?.cover).toBeUndefined();
    expect(odd?.durationMs).toBeUndefined();
  });
});
