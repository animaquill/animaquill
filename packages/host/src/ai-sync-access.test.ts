import { describe, expect, it } from "vitest";
import {
  AiSyncBusy,
  browserAiSyncAccess,
  browserChatSyncAccess,
  fitsKeepalive,
} from "./ai-sync-access.ts";
import {
  AI_SECRET_BYTES,
  checkAiEntry,
  isLaterEntry,
  mergeSecret,
  readSecretTimes,
  readServiceSecret,
  urlHasSecret,
} from "./ai-sync-rules.ts";
import { AiSyncNewer, AiSyncTooLarge, ChatNewer, CloudOtherAccount } from "./index.ts";

/** The AI settings, keys and conversations that go with an account, as the browser reaches them. */

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("the AI settings of an account, over HTTP", () => {
  it("has the platform's times agree with this computer's clock, both ways", async () => {
    let clock = 1_000_000;
    const sent: any[] = [];
    const access = browserAiSyncAccess({
      api: (path) => `/api${path}`,
      changeHeaders: { "x-test": "1" },
      now: () => (clock += 10),
      fetch: async (input, init) => {
        if (init?.body)
          sent.push({ url: input, body: JSON.parse(String(init.body)), headers: init.headers });
        const state = {
          account: "u",
          revision: 3,
          format: 1,
          entries: {
            "field:a": { at: clock + 3600_000, value: 1 },
            "service:x": { at: 5, deleted: true },
          },
          keys: {
            s1: { at: clock + 3600_000, key: "sk" },
            s2: {
              at: 7,
              secret: { key: "sk-2", baseUrl: "https://gw.example", headers: { a: "b" } },
            },
          },
        };
        return init?.method === "POST"
          ? json(200, { now: clock + 3600_000, refused: ["field:b"], state })
          : json(200, { now: clock + 3600_000, ...state });
      },
    });
    const read = await access.read();
    expect("entries" in read && read.entries["field:a"]).toEqual({ at: 1_000_015, value: 1 });
    // A key alone, as a platform of before has it, is what is secret of its service.
    expect("keys" in read && read.keys.s1).toEqual({ at: 1_000_015, secret: { key: "sk" } });
    expect("keys" in read && read.keys.s2?.secret).toEqual({
      key: "sk-2",
      baseUrl: "https://gw.example",
      headers: { a: "b" },
    });
    const changed = await access.change({
      account: "u",
      entries: [{ name: "field:a", at: 1, value: 2 }],
      keys: [],
    });
    expect(changed.refused).toEqual(["field:b"]);
    expect(sent[0].url).toBe("/api/me/ai-settings");
    expect(sent[0].headers).toMatchObject({ "x-test": "1" });
    expect(sent[0].body).toMatchObject({
      account: "u",
      format: 1,
      entries: [{ name: "field:a", at: 1, value: 2 }],
    });
  });

  it("says what the platform said, as errors to tell apart", async () => {
    const answering = (status: number, body: unknown, headers?: Record<string, string>) =>
      browserAiSyncAccess({ api: (path) => path, fetch: async () => json(status, body, headers) });
    const change = (status: number, body: unknown, headers?: Record<string, string>) =>
      answering(status, body, headers).change({ account: "u", entries: [], keys: [] });
    await expect(change(409, { error: "newer" })).rejects.toBeInstanceOf(AiSyncNewer);
    await expect(change(409, { error: "otherAccount" })).rejects.toBeInstanceOf(CloudOtherAccount);
    await expect(change(413, { error: "tooLarge" })).rejects.toBeInstanceOf(AiSyncTooLarge);
    await expect(change(429, { error: "busy" }, { "retry-after": "7" })).rejects.toEqual(
      new AiSyncBusy(7000),
    );
    // What cannot be read is not taken for nothing.
    await expect(
      answering(200, {
        now: 1,
        account: "u",
        revision: 1,
        format: 1,
        entries: { "Bad Name": { at: 1, value: 1 } },
        keys: {},
      }).read(),
    ).rejects.toThrow();
  });

  it("conversations: a newer one elsewhere, and one the platform does not keep", async () => {
    const answering = (status: number, body: unknown) =>
      browserChatSyncAccess({ api: (path) => path, fetch: async () => json(status, body) });
    const chat = { id: "c1", project: "local", title: "t", updatedAt: 1, entries: [] };
    await expect(
      answering(409, { error: "newer", revision: 4 }).save("p", chat, 1),
    ).rejects.toEqual(new ChatNewer(4));
    expect(await answering(404, { error: "notFound" }).save("p", chat, null)).toBeUndefined();
    expect(await answering(413, { error: "tooLarge" }).save("p", chat, null)).toBeUndefined();
    expect(await answering(200, { revision: 2 }).save("p", chat, 1)).toBe(2);
  });
});

describe("what an entry can be", () => {
  it("a model of a service, by the service and its id, with nothing of a secret", () => {
    const model = {
      id: "team/claude-x",
      name: "Claude X",
      contextWindow: 200000,
      thinkingLevelMap: { off: null, high: "max" },
    };
    expect(checkAiEntry("model:s1/team/claude-x", model)).toBe(true);
    expect(checkAiEntry("model:s1/other", model)).toBe(false);
    expect(checkAiEntry("model:/team/claude-x", model)).toBe(false);
    expect(checkAiEntry("model:s 1/team/claude-x", model)).toBe(false);
    expect(checkAiEntry("model:s1/team/claude-x", { ...model, apiKey: "x" })).toBe(false);
    // Where it is and its headers are secret, never in an entry.
    expect(checkAiEntry("model:s1/team/claude-x", { ...model, headers: { "x-team": "v" } })).toBe(
      false,
    );
    expect(
      checkAiEntry("model:s1/team/claude-x", { ...model, baseUrl: "https://x.example/v1" }),
    ).toBe(false);
  });

  it("services as they are, nothing under the name of a secret", () => {
    const service = {
      id: "s1",
      kind: "anthropic",
      name: "A",
      route: "direct",
      enabled: [],
    };
    expect(checkAiEntry("service:s1", service)).toBe(true);
    expect(checkAiEntry("service:s1", { ...service, apiKey: "sk" })).toBe(false);
    expect(checkAiEntry("service:s1", { ...service, extra: { nested: { token: "x" } } })).toBe(
      false,
    );
    expect(checkAiEntry("service:s2", service)).toBe(false);
    expect(checkAiEntry("default", null)).toBe(true);
    expect(checkAiEntry("future-kind:x", { anything: true })).toBe(true);
    expect(checkAiEntry("field:password", "x")).toBe(false);
    // No key in the address either.
    for (const baseUrl of [
      "https://user:pass@api.example.com",
      "https://api.example.com/v1?key=sk",
      "https://api.example.com/v1?api_key=sk",
      "https://api.example.com/v1?access_token=sk",
    ]) {
      expect(urlHasSecret(baseUrl), baseUrl).toBe(true);
    }
    expect(urlHasSecret("https://api.example.com/v1?region=eu")).toBe(false);
    expect(urlHasSecret("not an address")).toBe(false);
  });

  it("the later wins, a tie goes to taking away", () => {
    expect(isLaterEntry(undefined, { at: 1 })).toBe(true);
    expect(isLaterEntry({ at: 2 }, { at: 1 })).toBe(false);
    expect(isLaterEntry({ at: 2 }, { at: 2, deleted: true })).toBe(true);
    expect(isLaterEntry({ at: 2, deleted: true }, { at: 2 })).toBe(false);
  });
});

describe("the pictures of conversations of an account, over HTTP", () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hex = async (data: Uint8Array<ArrayBuffer>) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");

  it("puts one straight into the storage, and has the platform check it", async () => {
    const hash = await hex(bytes);
    const asked: { url: string; method: string; headers: unknown }[] = [];
    const access = browserChatSyncAccess({
      api: (path) => `/api${path}`,
      changeHeaders: { "x-test": "1" },
      fetch: async (input, init) => {
        asked.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers });
        if (String(input) === "/api/me/chat-images")
          return json(200, {
            upload: {
              method: "PUT",
              url: "https://objects.example/b/x",
              headers: { "x-amz-checksum-sha256": "c" },
            },
          });
        if (String(input).startsWith("https://objects.example")) return new Response(null);
        return json(200, { state: "ready" });
      },
    });
    const ref = { image: `sha256:${hash}`, type: "image/jpeg", width: 2, height: 2, bytes: 4 };
    expect(await access.putImage!(ref, new Blob([bytes], { type: "image/jpeg" }))).toBe("stored");
    expect(asked.map((each) => `${each.method} ${each.url}`)).toEqual([
      "POST /api/me/chat-images",
      "PUT https://objects.example/b/x",
      `POST /api/me/chat-images/${hash}/done`,
    ]);
    expect(asked[1]!.headers).toEqual({
      "content-type": "image/jpeg",
      "x-amz-checksum-sha256": "c",
    });
  });

  it("says when there is no room, and takes a picture read back only where it is the one asked for", async () => {
    const hash = await hex(bytes);
    let stored: Uint8Array = bytes;
    const access = browserChatSyncAccess({
      api: (path) => `/api${path}`,
      fetch: async (input) => {
        if (String(input) === "/api/me/chat-images")
          return json(413, { error: "full", used: 1, limit: 1 });
        if (String(input).startsWith("https://objects.example"))
          return new Response(new Blob([stored as Uint8Array<ArrayBuffer>]));
        return json(200, { url: "https://objects.example/b/x", type: "image/jpeg" });
      },
    });
    const ref = { image: `sha256:${hash}`, type: "", width: 0, height: 0, bytes: 0 };
    expect(await access.putImage!(ref, new Blob([bytes]))).toBe("full");
    const got = await access.getImage!(ref);
    expect(got?.type).toBe("image/jpeg");
    expect(new Uint8Array(await got!.arrayBuffer())).toEqual(bytes);
    stored = new Uint8Array([9, 9, 9, 9]);
    await expect(access.getImage!(ref)).rejects.toThrow();
  });
});

describe("what is secret of a service", () => {
  it("is its key, address and headers, and those of its models, as texts", () => {
    const secret = {
      key: "sk-1",
      baseUrl: "https://gw.example/v1?key=abc",
      headers: { "api-key": "sk-2" },
      models: { "m/1": { baseUrl: "https://other.example", headers: { a: "b" } }, empty: {} },
    };
    // Its address can carry a key now: it is sealed as the key is.
    expect(readServiceSecret({ ...secret, extra: 1 })).toEqual({
      ...secret,
      models: { "m/1": secret.models["m/1"] },
    });
    expect(readServiceSecret({})).toEqual({});
    for (const wrong of [
      "sk",
      { key: "" },
      { key: 1 },
      { baseUrl: 1 },
      { headers: { a: 1 } },
      { headers: "a" },
      { models: { m: { headers: { a: 1 } } } },
      { key: "x".repeat(AI_SECRET_BYTES) },
    ])
      expect(readServiceSecret(wrong), JSON.stringify(wrong).slice(0, 80)).toBeUndefined();
  });

  it("is never in an entry: a service or a model with its address or headers is not taken", () => {
    const service = { id: "s", kind: "custom", name: "s", route: "direct", enabled: [] };
    expect(checkAiEntry("service:s", service)).toBe(true);
    expect(checkAiEntry("service:s", { ...service, baseUrl: "https://a.example" })).toBe(false);
    expect(checkAiEntry("service:s", { ...service, headers: { a: "b" } })).toBe(false);
  });
});

describe("what is secret of a service, changed in two places", () => {
  it("is merged part by part, each the later, and the same once merged again", () => {
    const kept = { at: 10, secret: { key: "old", baseUrl: "https://a.example" } };
    const key = {
      at: 20,
      secret: { key: "new", baseUrl: "https://a.example" },
      fieldsAt: { key: 20 },
    };
    const address = {
      at: 15,
      secret: { key: "old", baseUrl: "https://b.example" },
      fieldsAt: { key: 10, baseUrl: 15, headers: 15, models: 15 },
    };
    const one = mergeSecret(mergeSecret(kept, key), address);
    const two = mergeSecret(mergeSecret(kept, address), key);
    expect(one.secret).toEqual({ key: "new", baseUrl: "https://b.example" });
    expect(two.secret).toEqual(one.secret);
    expect(mergeSecret(one, one)).toEqual(one);
    expect(readSecretTimes({ key: 1, other: 2, baseUrl: "x" })).toEqual({ key: 1 });
  });
});

describe("changes that may outlive the page", () => {
  it("go so by their bytes, not their characters: a large Chinese text goes as any other", async () => {
    expect(fitsKeepalive("a".repeat(59_000))).toBe(true);
    // 22,000 characters of three bytes each are 66,000 bytes: over what a browser takes.
    expect(fitsKeepalive("字".repeat(22_000))).toBe(false);
    const asked: (boolean | undefined)[] = [];
    const access = browserAiSyncAccess({
      api: (path) => path,
      fetch: async (_input, init) => {
        asked.push(init?.keepalive);
        return new Response(JSON.stringify({ error: "busy" }), {
          status: 429,
          headers: { "retry-after": "1" },
        });
      },
    });
    const change = (text: string) =>
      access
        .change({
          account: "u",
          entries: [{ name: "field:prompt", at: 1, value: text }],
          keys: [],
        })
        .catch(() => {});
    await change("短的提示");
    await change("字".repeat(22_000));
    expect(asked).toEqual([true, false]);
  });
});
