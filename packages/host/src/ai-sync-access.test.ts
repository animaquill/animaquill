import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { AiSyncBusy, browserAiSyncAccess, browserChatSyncAccess } from "./ai-sync-access.ts";
import { browserAccountKeys } from "./ai.ts";
import { checkAiEntry, isLaterEntry } from "./ai-sync-rules.ts";
import { AiSyncNewer, AiSyncOff, AiSyncTooLarge, ChatNewer, CloudOtherAccount } from "./index.ts";

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
          enabled: true,
          revision: 3,
          format: 1,
          entries: {
            "field:a": { at: clock + 3600_000, value: 1 },
            "service:x": { at: 5, deleted: true },
          },
          keys: { s1: { at: clock + 3600_000, key: "sk" } },
        };
        return init?.method === "POST"
          ? json(200, { now: clock + 3600_000, refused: ["field:b"], state })
          : json(200, { now: clock + 3600_000, ...state });
      },
    });
    const read = await access.read();
    expect("entries" in read && read.entries["field:a"]).toEqual({ at: 1_000_015, value: 1 });
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
    await expect(change(409, { error: "off" })).rejects.toBeInstanceOf(AiSyncOff);
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
        enabled: true,
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

describe("keys of accounts in this browser", () => {
  it("each account's apart, and gone with it", async () => {
    const factory = new IDBFactory();
    const keys = browserAccountKeys(() => factory);
    await keys.of("u1").write("s1", "sk-1");
    await keys.of("u2").write("s1", "sk-2");
    expect(await keys.of("u1").read("s1")).toBe("sk-1");
    expect(await keys.of("u2").list()).toEqual(["s1"]);
    await keys.forget("u1");
    expect(await keys.of("u1").list()).toEqual([]);
    expect(await keys.of("u2").read("s1")).toBe("sk-2");
  });
});

describe("what an entry can be", () => {
  it("services as they are, nothing under the name of a secret", () => {
    const service = {
      id: "s1",
      kind: "anthropic",
      name: "A",
      baseUrl: "https://x",
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
  });

  it("the later wins, a tie goes to taking away", () => {
    expect(isLaterEntry(undefined, { at: 1 })).toBe(true);
    expect(isLaterEntry({ at: 2 }, { at: 1 })).toBe(false);
    expect(isLaterEntry({ at: 2 }, { at: 2, deleted: true })).toBe(true);
    expect(isLaterEntry({ at: 2, deleted: true }, { at: 2 })).toBe(false);
  });
});
