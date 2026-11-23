import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MODELS_DEV_URL } from "@animaquill/host/model-catalog";
import { quiet, world, type World } from "../test/archive-support.ts";
import { createTestDatabase, TEST_DATABASE, type TestDatabase } from "../test/database.ts";
import { platform } from "../test/platform-support.ts";
import { SyncHub } from "../sync/hub.ts";
import { ModelCatalogCache } from "./catalog.ts";

/**
 * The open catalog of models as the platform keeps it for editors (ai/catalog.ts): taken at most
 * once an hour, one request for all who ask at once, nothing of anyone in it, the old one kept
 * where models.dev fails; and only for people signed in.
 */

const CATALOG = {
  anthropic: {
    name: "Anthropic",
    api: "https://api.anthropic.com",
    models: {
      "claude-x": {
        id: "claude-x",
        name: "Claude X",
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 200_000, output: 64_000 },
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
      },
    },
  },
};

/** models.dev as the test has it: what it was asked, with what, and what it answers. */
function fakeModelsDev() {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  let answer: () => Response = () => Response.json(CATALOG);
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), init });
    return answer();
  }) as typeof globalThis.fetch;
  return {
    fetch,
    asked,
    answer: (next: () => Response) => {
      answer = next;
    },
  };
}

describe("the platform's copy of the catalog of models", () => {
  test("taken from models.dev once an hour, flattened, with nothing of anyone", async () => {
    let now = 1_000_000;
    const dev = fakeModelsDev();
    const cache = new ModelCatalogCache({ fetch: dev.fetch, now: () => now });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    expect(dev.asked).toHaveLength(1);
    expect(dev.asked[0]?.url).toBe(MODELS_DEV_URL);
    const headers = new Headers(dev.asked[0]?.init?.headers);
    expect([...headers.keys()].toSorted()).toEqual(["accept", "user-agent"]);
    expect(headers.get("user-agent")).toBe("AnimaQuill-Platform/1");
    expect(a).toBe(b);
    expect(a).toEqual({
      fetchedAt: 1_000_000,
      entries: [
        {
          providerId: "anthropic",
          providerName: "Anthropic",
          providerBaseUrl: "https://api.anthropic.com",
          id: "claude-x",
          name: "Claude X",
          reasoning: true,
          image: true,
          contextWindow: 200_000,
          maxTokens: 64_000,
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        },
      ],
    });
    now += 59 * 60_000;
    await cache.get();
    expect(dev.asked).toHaveLength(1);
    now += 2 * 60_000;
    expect((await cache.get())?.fetchedAt).toBe(now);
    expect(dev.asked).toHaveLength(2);
  });

  test("where models.dev fails, the copy before stays, and it is not asked again at once", async () => {
    let now = 0;
    const dev = fakeModelsDev();
    const cache = new ModelCatalogCache({ fetch: dev.fetch, now: () => now });
    dev.answer(() => new Response("down", { status: 502 }));
    expect(await cache.get()).toBeUndefined();
    expect(await cache.get()).toBeUndefined();
    expect(dev.asked).toHaveLength(1);
    now += 61_000;
    dev.answer(() => Response.json(CATALOG));
    const first = await cache.get();
    expect(first?.entries).toHaveLength(1);
    now += 2 * 3600_000;
    dev.answer(() => new Response("{not json", { status: 200 }));
    expect(await cache.get()).toBe(first);
    dev.answer(() => Response.json({}));
    now += 61_000;
    expect(await cache.get()).toBe(first);
    // More than it takes, however it comes: given up on as it goes past, the copy before stays.
    dev.answer(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
            },
          }),
        ),
    );
    now += 61_000;
    expect(await cache.get()).toBe(first);
  });
});

describe.skipIf(!TEST_DATABASE)("the catalog of models through the API", () => {
  let t: TestDatabase;
  let w: World;
  let hub: SyncHub;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });
  beforeEach(async () => {
    w = await world(t.db);
    hub = new SyncHub({ db: t.db, log: quiet });
  });
  afterEach(() => hub.stop());

  test("for people signed in only, and the same for everyone", async () => {
    const dev = fakeModelsDev();
    const p = await platform(w, { hub, modelCatalog: { fetch: dev.fetch } });
    const out = await p.send("GET", "/api/ai/model-catalog", { signedIn: false });
    expect(out.status).toBe(401);
    expect(out.json).toEqual({ error: "signedOut" });
    expect(dev.asked).toHaveLength(0);

    const answer = await p.send("GET", "/api/ai/model-catalog");
    expect(answer.status).toBe(200);
    expect(answer.json.entries[0]).toMatchObject({ providerId: "anthropic", id: "claude-x" });
    expect(typeof answer.json.fetchedAt).toBe("number");
    expect(answer.headers["cache-control"]).toBe("private, max-age=600");
    await p.send("GET", "/api/ai/model-catalog");
    expect(dev.asked).toHaveLength(1);
    // Nothing of who asked went to models.dev.
    const sent = JSON.stringify(dev.asked);
    expect(sent).not.toContain(w.userId);
    expect(sent.toLowerCase()).not.toContain("cookie");
  });

  test("none to give: unavailable, said as such", async () => {
    const dev = fakeModelsDev();
    dev.answer(() => new Response("down", { status: 503 }));
    const p = await platform(w, { hub, modelCatalog: { fetch: dev.fetch } });
    const answer = await p.send("GET", "/api/ai/model-catalog");
    expect(answer.status).toBe(503);
    expect(answer.json).toEqual({ error: "unavailable" });
  });
});
