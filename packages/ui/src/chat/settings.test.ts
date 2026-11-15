import { readAiSettings } from "@animaquill/agent";
import { memoryKeys, type KeyStore, type SettingsStore } from "@animaquill/host";
import { COMPARISON_PACK_ID } from "@animaquill/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiSettingsStore, testKey } from "./settings.ts";

/**
 * Settings shared by the windows of a browser: what one saves, the others hear of, as with the
 * `storage` event (not the window that saved it).
 */
function browser(initial?: unknown) {
  const values = new Map<string, unknown>(initial === undefined ? [] : [["ai", initial]]);
  const listeners = new Set<{ store: SettingsStore; call: (value: unknown) => void }>();
  const windowOf = (): SettingsStore => {
    const store: SettingsStore = {
      load: async (key) => structuredClone(values.get(key)),
      save: async (key, value) => {
        values.set(key, structuredClone(value));
        for (const listener of listeners) {
          if (listener.store !== store) listener.call(structuredClone(value));
        }
      },
      listen: (key, call) => {
        const entry = { store, call: (value: unknown) => key === "ai" && call(value) };
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
    };
    return store;
  };
  const keys = memoryKeys();
  const open = async (keyStore: KeyStore = keys) => {
    const messages = { saveFailed: vi.fn(), keyFailed: vi.fn() };
    const ai = new AiSettingsStore(windowOf(), keyStore, messages);
    await ai.load();
    return ai;
  };
  /** A page of before saves settings, which every window hears of. */
  const oldWrite = (value: unknown) => {
    values.set("ai", structuredClone(value));
    for (const listener of listeners) listener.call(structuredClone(value));
  };
  return { values, keys, open, oldWrite };
}

/** Lets what other windows saved arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A service as version 1 (until 0.3.55) saved it. */
const v1Service = (id: string, kind: string, model: string) => ({
  id,
  kind,
  name: id,
  baseUrl: kind === "anthropic" ? "https://api.anthropic.com" : "https://api.deepseek.com",
  model,
  route: "direct",
});

/** What Anthropic streams for an answer of a few words. */
function anthropicSaid(text: string): string {
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "m",
          type: "message",
          role: "assistant",
          model: "claude-haiku-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AI settings of before", () => {
  it("come up as version 4 with every service, key, model and pack choice", async () => {
    const { values, keys, open } = browser({
      services: [v1Service("a", "anthropic", "claude-opus-5-5"), v1Service("b", "deepseek", "")],
      current: "a",
      maxToolCalls: 80,
      packFor: { "claude-opus-5-5": "lin/steady" },
    });
    await keys.write("a", { key: "sk-ant-0123456789abcd" });
    const ai = await open();
    const snapshot = ai.getSnapshot();
    expect(snapshot.services.map(({ id, enabled }) => [id, enabled])).toEqual([
      ["a", ["claude-opus-5-5"]],
      ["b", []],
    ]);
    expect(snapshot.default).toEqual({ service: "a", model: "claude-opus-5-5" });
    expect(snapshot.keyed.has("a")).toBe(true);
    expect(snapshot.hints.get("a")).toBe("abcd");
    expect(snapshot.packFor).toEqual({ "claude-opus-5-5": "lin/steady" });
    // The addresses went into what is secret of each service at once, and nothing else changed.
    await settle();
    expect(values.get("ai")).toMatchObject({ version: 4, current: "a", maxToolCalls: 80 });
    expect(JSON.stringify(values.get("ai"))).not.toContain("https://");
    expect(await keys.read("a")).toEqual({
      key: "sk-ant-0123456789abcd",
      baseUrl: "https://api.anthropic.com",
    });
    expect(await keys.read("b")).toEqual({ baseUrl: "https://api.deepseek.com" });
    expect(snapshot.services.map(({ baseUrl }) => baseUrl)).toEqual([
      "https://api.anthropic.com",
      "https://api.deepseek.com",
    ]);

    ai.setEnabled("a", "claude-sonnet-5-5", true);
    const saved = values.get("ai") as Record<string, unknown>;
    expect(saved).toMatchObject({
      version: 4,
      current: "a",
      maxToolCalls: 80,
      packFor: { "claude-opus-5-5": "lin/steady" },
    });
    expect(saved.services).toEqual([
      expect.objectContaining({
        id: "a",
        enabled: ["claude-opus-5-5", "claude-sonnet-5-5"],
        model: "claude-opus-5-5",
      }),
      expect.objectContaining({ id: "b", enabled: [], model: "" }),
    ]);
    expect((await keys.read("a"))?.key).toBe("sk-ant-0123456789abcd");
  });

  it("with the words to compare with on keep them for the models that were on", async () => {
    const { open } = browser({
      services: [v1Service("a", "anthropic", "claude-opus-5-5")],
      current: "a",
      comparisonTexts: true,
    });
    const ai = await open();
    expect(ai.getSnapshot().showHiddenPacks).toBe(true);
    expect(ai.getSnapshot().packFor).toEqual({ "claude-opus-5-5": COMPARISON_PACK_ID });
  });

  it("keep services this editor cannot read, and write them back", async () => {
    const odd = {
      id: "x",
      kind: "from-later",
      name: "X",
      baseUrl: "https://x",
      model: "m",
      route: "direct",
    };
    const { values, open } = browser({
      services: [v1Service("a", "anthropic", "claude-opus-5-5"), odd],
      current: "a",
      later: { kept: true },
    });
    const ai = await open();
    expect(ai.getSnapshot().services.map(({ id }) => id)).toEqual(["a"]);
    ai.setMaxToolCalls(20);
    const saved = values.get("ai") as { services: unknown[]; later: unknown };
    expect(saved.services).toContainEqual(odd);
    expect(saved.later).toEqual({ kept: true });
  });
});

describe("AI settings this editor cannot take", () => {
  it("are left as they are, until people start again", async () => {
    const newer = { version: 5, services: [{ id: "a", kind: "anthropic", future: true }] };
    const { values, open } = browser(newer);
    const ai = await open();
    expect(ai.getSnapshot().held).toBe("newer");
    expect(ai.add("anthropic", "Anthropic")).toBeUndefined();
    ai.setMaxToolCalls(20);
    ai.choosePack(["m"], "lin/steady");
    expect(values.get("ai")).toEqual(newer);

    ai.reset();
    expect(ai.getSnapshot().held).toBeUndefined();
    expect(readAiSettings(values.get("ai"))).toMatchObject({
      kind: "ok",
      settings: { services: [] },
    });
  });

  it("that are not settings at all are not written over either", async () => {
    const { values, open } = browser("garbage");
    const ai = await open();
    expect(ai.getSnapshot().held).toBe("broken");
    ai.add("anthropic", "Anthropic");
    expect(values.get("ai")).toBe("garbage");
  });

  it("are taken once another window writes ones it can", async () => {
    const { open } = browser({ version: 5, services: [] });
    const held = await open();
    expect(held.getSnapshot().held).toBe("newer");
    const other = await open();
    other.reset();
    other.add("anthropic", "Anthropic", { enabled: ["claude-opus-5-5"] });
    await settle();
    expect(held.getSnapshot().held).toBeUndefined();
    expect(held.getSnapshot().services).toHaveLength(1);
  });
});

describe("models of services", () => {
  it("keep at least one on, and the default on one that is", async () => {
    const { open } = browser();
    const ai = await open();
    const a = ai.add("anthropic", "Anthropic", { enabled: ["claude-opus-5-5"] }) as string;
    expect(ai.getSnapshot().default).toEqual({ service: a, model: "claude-opus-5-5" });
    expect(ai.setEnabled(a, "claude-opus-5-5", false)).toBe("last");
    expect(ai.setAllEnabled(a, ["claude-opus-5-5"], false)).toBe("last");
    expect(ai.serviceOf(a)?.enabled).toEqual(["claude-opus-5-5"]);

    const d = ai.add("deepseek", "DeepSeek", { enabled: ["deepseek-flash"] }) as string;
    ai.setDefault({ service: d, model: "deepseek-v4-pro" });
    expect(ai.serviceOf(d)?.enabled).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(ai.defaultModel()).toMatchObject({ service: { id: d }, model: "deepseek-v4-pro" });
    // Off, the default goes to the first model on.
    expect(ai.setEnabled(d, "deepseek-v4-pro", false)).toBeUndefined();
    expect(ai.getSnapshot().default).toEqual({ service: a, model: "claude-opus-5-5" });
    // The service goes, its models with it.
    await ai.remove(a);
    expect(ai.getSnapshot().default).toEqual({ service: d, model: "deepseek-flash" });
    expect(ai.setAllEnabled(d, ["deepseek-flash"], false)).toBe("last");
  });

  it("list what pi knows, what people added, and what is on: those on first, in their order", async () => {
    const { open } = browser();
    const ai = await open();
    await ai.loadKnown("anthropic");
    const a = ai.add("anthropic", "Anthropic", { enabled: ["claude-gone-1"] }) as string;
    ai.addModels(a, [{ id: "claude-mine", added: "hand" }]);
    ai.setEnabled(a, "claude-opus-5-5", true);
    const rows = ai.modelsFor(a);
    expect(rows.slice(0, 3).map((row) => row.id)).toEqual([
      "claude-gone-1",
      "claude-mine",
      "claude-opus-5-5",
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("claude-opus-5-5")).toMatchObject({
      inCatalog: true,
      enabled: true,
      reasoning: true,
    });
    expect(byId.get("claude-opus-5-5")?.values.cost).toBeDefined();
    expect(byId.get("claude-opus-5-5")?.levels).toContain("high");
    expect(byId.get("claude-mine")).toMatchObject({
      custom: true,
      inCatalog: false,
      enabled: true,
    });
    expect(byId.get("claude-sonnet-5-5")?.enabled).toBe(false);

    // One of pi's goes off and stays; one people added goes.
    expect(ai.removeModel(a, "claude-opus-5-5")).toBeUndefined();
    expect(ai.modelOf(a, "claude-opus-5-5")?.enabled).toBe(false);
    ai.removeModel(a, "claude-mine");
    expect(ai.modelOf(a, "claude-mine")).toBeUndefined();
    expect(ai.serviceOf(a)?.enabled).toEqual(["claude-gone-1"]);
  });

  it("take a reasoning of their own, and go back to the pack's", async () => {
    const { open } = browser();
    const ai = await open();
    ai.setReasoning("claude-opus-5-5", "high");
    expect(ai.getSnapshot().reasoningFor).toEqual({ "claude-opus-5-5": "high" });
    ai.setReasoning("claude-opus-5-5", undefined);
    expect(ai.getSnapshot().reasoningFor).toBeUndefined();
  });
});

describe("two windows", () => {
  it("follow each other's changes", async () => {
    const { open } = browser();
    const one = await open();
    const two = await open();
    const id = one.add("anthropic", "Anthropic", { enabled: ["claude-opus-5-5"] }) as string;
    await settle();
    expect(two.serviceOf(id)?.enabled).toEqual(["claude-opus-5-5"]);
    two.update(id, { baseUrl: "https://proxy.example" });
    await settle();
    expect(one.serviceOf(id)?.baseUrl).toBe("https://proxy.example");
    two.setReasoning("claude-opus-5-5", "low");
    await settle();
    expect(one.getSnapshot().reasoningFor).toEqual({ "claude-opus-5-5": "low" });
  });

  it("keep version 3 when a page of before writes version 1 over it, with what that page changed", async () => {
    const { values, open } = browser();
    const ai = await open();
    const a = ai.add("anthropic", "Anthropic", {
      enabled: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    }) as string;
    ai.setReasoning("claude-opus-5-5", "high");
    await settle();
    // A page of 0.3.56 reads what is there, people change the limit there, and it writes back
    // what it knows: one model per service, no version. A service without its address it cannot
    // read, and leaves out.
    const old = structuredClone(values.get("ai")) as {
      services: Record<string, unknown>[];
      current: string;
    };
    expect(old.services[0]).not.toHaveProperty("baseUrl");
    const written = { services: [], current: old.current, maxToolCalls: 9 };
    values.set("ai", written);
    // This window hears of it, as of any window.
    const other = await open();
    expect(other.serviceOf(a)?.enabled).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(other.getSnapshot()).toMatchObject({
      maxToolCalls: 9,
      reasoningFor: { "claude-opus-5-5": "high" },
      default: { service: a, model: "claude-opus-5-5" },
    });
    // Where it is stays, as what is secret of it.
    expect(other.serviceOf(a)?.baseUrl).toBe("https://api.anthropic.com");
    // And version 4 is back where the page of before reads, which it takes as it is.
    expect(values.get("ai")).toMatchObject({ version: 4, maxToolCalls: 9, current: a });
  });
});

describe("a page of before, while two of version 2 are open", () => {
  it("does not take back what version 2 saved after that page wrote", async () => {
    const { values, open, oldWrite } = browser();
    const one = await open();
    const a = one.add("anthropic", "Anthropic", {
      enabled: ["claude-opus-5-5", "claude-sonnet-5-5"],
    }) as string;
    await settle();
    const two = await open();
    // The page of before writes what it read (nothing, without addresses); before the second window
    // hears of it, the first one renames the service, which is saved at once.
    const written = { services: [], current: a, maxToolCalls: 50 };
    oldWrite(written);
    one.update(a, { name: "公司的 Anthropic" });
    await settle();
    expect(two.serviceOf(a)).toMatchObject({
      name: "公司的 Anthropic",
      enabled: ["claude-opus-5-5", "claude-sonnet-5-5"],
    });
    expect(values.get("ai")).toMatchObject({ version: 4 });
  });
});

describe("tests of a connection", () => {
  const KEY = "sk-ant-0123456789SECRET";

  it("ask the cheapest recommended model for a word, and say what kind of failure", async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    let answer: () => Response = () =>
      new Response(anthropicSaid("OK"), { headers: { "content-type": "text/event-stream" } });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return answer();
    });
    const { open } = browser();
    const ai = await open();
    const draft = {
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      route: "direct",
    } as const;
    const tried = await ai.tryService(draft, KEY);
    expect(tried.test).toMatchObject({ state: "ok", text: "OK" });
    expect(tried.recommended).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(sent[0]).toMatchObject({
      url: expect.stringMatching(/^https:\/\/api\.anthropic\.com\/v1\/messages\b/),
      body: { model: "claude-haiku-5-5", max_tokens: 16 },
    });

    answer = () =>
      Response.json(
        { type: "error", error: { type: "authentication_error", message: `bad ${KEY}` } },
        { status: 401 },
      );
    const refused = await ai.tryService(draft, KEY);
    expect(refused.test).toMatchObject({ state: "failed", failure: { kind: "key" } });
    expect(JSON.stringify(refused)).not.toContain("SECRET");

    answer = () => {
      throw new TypeError("Failed to fetch");
    };
    expect((await ai.tryService(draft, KEY)).test).toMatchObject({
      state: "failed",
      failure: { kind: "network" },
    });

    answer = () =>
      Response.json(
        { type: "error", error: { type: "not_found_error", message: "model: x" } },
        { status: 404 },
      );
    const id = ai.add("anthropic", "Anthropic", { enabled: ["claude-x"] }) as string;
    await ai.setKey(id, KEY);
    expect(await ai.test(id, "claude-x")).toMatchObject({ failure: { kind: "notFound" } });
    expect(ai.getSnapshot().tests.get(testKey(id, "claude-x"))).toMatchObject({ state: "failed" });
    expect(sent.at(-1)?.body).toMatchObject({ model: "claude-x" });
    // Another key: what the tests said of the one before no longer counts.
    await ai.setKey(id, "sk-ant-another-0123456789");
    expect(ai.getSnapshot().tests.size).toBe(0);
  });

  it("list the models of a service pi does not know, which is the test there", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/models");
      return Response.json({
        data: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"].map((id) => ({ id })),
      });
    });
    const { open } = browser();
    const ai = await open();
    const tried = await ai.tryService(
      {
        kind: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        route: "direct",
      },
      "sk-0123456789",
    );
    expect(tried.test).toMatchObject({ state: "ok", models: 4 });
    expect(tried.recommended).toEqual(["qwen-long", "qwen-max", "qwen-plus"]);
  });

  it("say why where there is no way to the service", async () => {
    const { open } = browser();
    const ai = await open();
    expect(
      (
        await ai.tryService(
          { kind: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", route: "relay" },
          "k",
        )
      ).test,
    ).toEqual({ state: "held", hold: "relayMissing" });
    expect(
      (await ai.tryService({ kind: "openai-compatible", baseUrl: "", route: "direct" }, "")).test,
    ).toEqual({
      state: "held",
      hold: "badUrl",
    });
  });
});

describe("the details of models", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** models.dev as the test has it, with how often it was asked. */
  const MODELS_DEV = {
    alibaba: {
      name: "Alibaba",
      api: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      models: {
        "qwen3-max": {
          id: "qwen3-max",
          name: "Qwen3 Max",
          reasoning: true,
          modalities: { input: ["text"], output: ["text"] },
          limit: { context: 262144, output: 32768 },
          cost: { input: 1.2, output: 6, cache_read: 0.24 },
        },
      },
    },
    a: { models: { "shared-x": { id: "shared-x", cost: { input: 1, output: 2 } } } },
    b: { models: { "shared-x": { id: "shared-x", cost: { input: 3, output: 4 } } } },
  };

  async function withCatalog(
    options: { readonly platform?: boolean; readonly fails?: boolean } = {},
  ) {
    const asked: string[] = [];
    const fetch = (async (input: RequestInfo | URL) => {
      asked.push(String(input));
      if (options.fails) throw new TypeError("Failed to fetch");
      return Response.json(MODELS_DEV);
    }) as typeof globalThis.fetch;
    const cache = new Map<string, unknown>();
    const keys = memoryKeys();
    const settingsStore: SettingsStore = {
      load: async () => undefined,
      save: async () => {},
      listen: () => () => {},
    };
    const platformAsked: number[] = [];
    const ai = new AiSettingsStore(
      settingsStore,
      keys,
      { saveFailed: vi.fn(), keyFailed: vi.fn() },
      undefined,
      {
        fetch,
        cache: {
          read: async (key) => structuredClone(cache.get(key)),
          write: async (key, value) => {
            cache.set(key, structuredClone(value));
          },
        },
        ...(options.platform && {
          platform: async () => {
            platformAsked.push(1);
            return { fetchedAt: Date.now(), entries: [] };
          },
        }),
      },
    );
    await ai.load();
    return { ai, asked, cache, platformAsked };
  }

  it("fill a model added by hand from the catalogs, only what is empty, and undo it", async () => {
    const { ai, asked } = await withCatalog();
    const id = ai.add("dashscope", "千问", { enabled: [] }) as string;
    ai.addModels(id, [{ id: "qwen3-max", added: "hand" }]);
    await vi.waitFor(() => expect(ai.modelOf(id, "qwen3-max")?.config?.filled).toBeDefined());
    const row = ai.modelOf(id, "qwen3-max");
    expect(row?.values).toMatchObject({
      name: "Qwen3 Max",
      reasoning: true,
      contextWindow: 262144,
      maxTokens: 32768,
      cost: { input: 1.2, output: 6, cacheRead: 0.24, cacheWrite: 0 },
    });
    expect(row?.config?.filled).toMatchObject({
      from: ["models.dev"],
      by: "base-url",
      matched: "Alibaba",
    });
    // Nothing of anyone went with the request for the catalog.
    expect(asked).toEqual(["https://models.dev/api.json"]);

    // People's cell stays theirs through filling again, and undoing it.
    ai.editModel(id, "qwen3-max", "contextWindow", 100_000);
    ai.undoFill(id, "qwen3-max");
    expect(ai.modelOf(id, "qwen3-max")?.values).toEqual({ contextWindow: 100_000 });
    await ai.fillModels(id, ["qwen3-max"], true);
    expect(ai.modelOf(id, "qwen3-max")?.values).toMatchObject({
      contextWindow: 100_000,
      maxTokens: 32768,
    });
    await ai.revertField(id, "qwen3-max", "contextWindow");
    expect(ai.modelOf(id, "qwen3-max")?.values.contextWindow).toBe(262144);
    expect(ai.modelOf(id, "qwen3-max")?.config?.edited).toBeUndefined();
  });

  it("take no price where the catalog's providers do not agree, and say why", async () => {
    const { ai } = await withCatalog();
    const id = ai.add("openai-compatible", "网关", { baseUrl: "https://gw.example/v1" }) as string;
    ai.addModels(id, [{ id: "shared-x", added: "hand" }]);
    await vi.waitFor(() => expect(ai.modelOf(id, "shared-x")?.config?.filled).toBeDefined());
    expect(ai.modelOf(id, "shared-x")?.values.cost).toBeUndefined();
    expect(ai.modelOf(id, "shared-x")?.config?.filled?.priceDoubt).toBe("conflict");
  });

  it("keep the catalog an hour on the device, and ask the platform where models.dev cannot be read", async () => {
    const first = await withCatalog();
    await first.ai.loadCatalog();
    expect(first.ai.getSnapshot().catalog).toMatchObject({ state: "ok", from: "models.dev" });
    const failing = await withCatalog({ fails: true, platform: true });
    await failing.ai.loadCatalog();
    expect(failing.platformAsked).toHaveLength(1);
    expect(failing.ai.getSnapshot().catalog).toMatchObject({ state: "ok", from: "platform" });
    const nowhere = await withCatalog({ fails: true });
    expect(await nowhere.ai.loadCatalog()).toBeUndefined();
    expect(nowhere.ai.getSnapshot().catalog).toEqual({ state: "failed" });
  });

  it("follow a model under another id: the default, the models on, packs and reasoning", async () => {
    const { open } = browser();
    const ai = await open();
    const id = ai.add("openai-compatible", "网关", { baseUrl: "https://gw.example/v1" }) as string;
    ai.addModels(id, [{ id: "old-name", added: "hand" }]);
    ai.setDefault({ service: id, model: "old-name" });
    ai.choosePack(["old-name"], "lin/steady");
    ai.setReasoning("old-name", "high");
    ai.editModel(id, "old-name", "maxTokens", 1000);
    expect(ai.renameModel(id, "old-name", "new-name")).toBeUndefined();
    const now = ai.getSnapshot();
    expect(now.default).toEqual({ service: id, model: "new-name" });
    expect(ai.serviceOf(id)?.enabled).toEqual(["new-name"]);
    expect(now.packFor).toEqual({ "new-name": "lin/steady" });
    expect(now.reasoningFor).toEqual({ "new-name": "high" });
    expect(ai.modelOf(id, "new-name")?.values.maxTokens).toBe(1000);
    expect(ai.modelOf(id, "old-name")).toBeUndefined();
    ai.addModels(id, [{ id: "other", added: "hand" }]);
    expect(ai.renameModel(id, "other", "new-name")).toBe("taken");
  });

  it("reach a model at its own address, by its own protocol, with the headers of both", async () => {
    const { open } = browser();
    const ai = await open();
    const id = ai.add("openai-compatible", "网关", {
      baseUrl: "https://gw.example/v1",
      api: "openai-responses",
      headers: { "x-team": "video" },
    }) as string;
    ai.addModels(id, [{ id: "m", added: "hand" }]);
    expect(ai.endpointOf(ai.serviceOf(id)!, "m")).toMatchObject({
      protocol: "openai-responses",
      baseUrl: "https://gw.example/v1",
      settings: { headers: { "x-team": "video" } },
    });
    ai.setModelOwn(id, "m", "baseUrl", "https://gw.example/claude");
    ai.setModelOwn(id, "m", "api", "anthropic-messages");
    ai.setModelOwn(id, "m", "headers", { "x-route": "a" });
    ai.editModel(id, "m", "thinking.low", null);
    expect(ai.endpointOf(ai.serviceOf(id)!, "m")).toMatchObject({
      protocol: "anthropic-messages",
      baseUrl: "https://gw.example/claude",
      settings: {
        headers: { "x-team": "video", "x-route": "a" },
        thinkingLevelMap: { low: null },
      },
    });
  });

  it("turn a whole service off and on again with the models it had on", async () => {
    const { open } = browser();
    const ai = await open();
    const a = ai.add("anthropic", "A", {
      enabled: ["claude-opus-5-5", "claude-haiku-5-5"],
    }) as string;
    expect(ai.setServiceOn(a, false)).toBe("last");
    const b = ai.add("deepseek", "D", { enabled: ["deepseek-flash"] }) as string;
    expect(ai.setServiceOn(a, false)).toBeUndefined();
    expect(ai.serviceOf(a)?.enabled).toEqual([]);
    ai.setServiceOn(a, true);
    expect(ai.serviceOf(a)?.enabled).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    expect(ai.serviceOf(a)?.paused).toBeUndefined();
    ai.moveModel(a, "claude-haiku-5-5", 0);
    expect(ai.serviceOf(a)?.enabled).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
    ai.moveService(b, 0);
    expect(ai.getSnapshot().services.map((service) => service.id)).toEqual([b, a]);
  });

  it("of one's own, added and removed: on as they come, gone from what is on and the default as they go (S-M2)", async () => {
    const { open } = browser();
    const ai = await open();
    const d = ai.add("deepseek", "D", { enabled: ["deepseek-flash"] }) as string;
    const own = ai.add("openai-compatible", "网关", { baseUrl: "https://gw.example.test/v1" });
    const gw = own as string;
    ai.addModels(gw, [
      { id: "qwen3-max", added: "hand" },
      { id: "kimi-k3", added: "service" },
    ]);
    expect(ai.serviceOf(gw)?.enabled).toEqual(["qwen3-max", "kimi-k3"]);
    ai.setDefault({ service: gw, model: "kimi-k3" });
    // Removed: off, its record gone, and the default on another model that is on.
    expect(ai.removeModel(gw, "kimi-k3")).toBeUndefined();
    expect(ai.serviceOf(gw)?.enabled).toEqual(["qwen3-max"]);
    expect(ai.serviceOf(gw)?.models?.map((model) => model.id)).toEqual(["qwen3-max"]);
    expect(ai.getSnapshot().default).toEqual({ service: d, model: "deepseek-flash" });

    // Turned off, it stays off as models are added; removing one takes it from those it had on.
    expect(ai.setServiceOn(gw, false)).toBeUndefined();
    ai.addModels(gw, [{ id: "glm-5", added: "hand" }]);
    expect(ai.serviceOf(gw)?.enabled).toEqual([]);
    expect(ai.serviceOf(gw)?.paused).toEqual(["qwen3-max", "glm-5"]);
    ai.removeModel(gw, "qwen3-max");
    expect(ai.serviceOf(gw)?.paused).toEqual(["glm-5"]);
    expect(ai.serviceOf(gw)?.models?.map((model) => model.id)).toEqual(["glm-5"]);
    ai.setServiceOn(gw, true);
    expect(ai.serviceOf(gw)?.enabled).toEqual(["glm-5"]);

    // The last model on anywhere is not removed.
    ai.removeModel(gw, "glm-5");
    expect(ai.removeModel(d, "deepseek-flash")).toBe("last");
    expect(ai.serviceOf(d)?.enabled).toEqual(["deepseek-flash"]);
  });

  it("mark a service whose last request failed, until one goes through (S-M2)", async () => {
    const { open } = browser();
    const ai = await open();
    const a = ai.add("anthropic", "A", { enabled: ["claude-opus-5-5"] }) as string;
    expect(ai.getSnapshot().failing.has(a)).toBe(false);
    ai.noteRequest(a, { kind: "key", message: "401" });
    expect(ai.getSnapshot().failing.get(a)).toMatchObject({ kind: "key" });
    ai.keepTest(a, { state: "ok", ms: 12 });
    expect(ai.getSnapshot().failing.has(a)).toBe(false);
    ai.keepTest(a, { state: "failed", failure: { kind: "network", message: "x" } });
    expect(ai.getSnapshot().failing.get(a)).toMatchObject({ kind: "network" });
    ai.noteRequest(a, undefined);
    expect(ai.getSnapshot().failing.has(a)).toBe(false);
  });

  it("forget what a service listed once where it is, or how it is talked to, changed", async () => {
    const { open } = browser();
    const ai = await open();
    const id = ai.add("openai-compatible", "网关", { baseUrl: "https://gw.example/v1" }) as string;
    const headersSent: (Headers | undefined)[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      headersSent.push(new Headers(init?.headers));
      return Response.json({ data: [{ id: "a" }, { id: "text-embedding-v4" }] });
    });
    ai.update(id, { headers: { "x-team": "video" } });
    await ai.fetchModels(id);
    expect(headersSent[0]?.get("x-team")).toBe("video");
    expect(ai.getSnapshot().listings.get(id)).toMatchObject({
      state: "ok",
      models: [{ id: "a" }, { id: "text-embedding-v4", chat: false }],
    });
    ai.update(id, { api: "anthropic-messages" });
    expect(ai.getSnapshot().listings.has(id)).toBe(false);
  });
});

describe("headers of before that cannot be sent", () => {
  it("go at once as the settings are read, and are said so once, not at every load", async () => {
    const { values } = browser({
      version: 3,
      services: [
        {
          id: "g",
          kind: "openai-compatible",
          name: "网关",
          baseUrl: "https://gw.example/v1",
          route: "direct",
          headers: { "x-team": "视频", "x-ok": "1" },
          enabled: ["m"],
        },
      ],
    });
    const messages = { saveFailed: vi.fn(), keyFailed: vi.fn(), headersLeftOut: vi.fn() };
    const store: SettingsStore = {
      load: async (key) => structuredClone(values.get(key)),
      save: async (key, value) => void values.set(key, structuredClone(value)),
      listen: () => () => {},
    };
    const keys = memoryKeys();
    const first = new AiSettingsStore(store, keys, messages);
    await first.load();
    expect(messages.headersLeftOut).toHaveBeenCalledTimes(1);
    await settle();
    expect((await keys.read("g"))?.headers).toEqual({ "x-ok": "1" });
    expect(values.get("ai")).toMatchObject({ version: 4 });
    const again = new AiSettingsStore(store, keys, messages);
    await again.load();
    expect(messages.headersLeftOut).toHaveBeenCalledTimes(1);
  });
});

describe("what is secret of a service: its key, address and headers", () => {
  const gateway = {
    id: "g",
    kind: "openai-compatible",
    name: "网关",
    baseUrl: "https://gw.example/v1",
    route: "direct",
    api: "openai-completions",
    headers: { "x-team": "video" },
    keyHeader: "api-key",
    enabled: ["m"],
    models: [
      { id: "m", added: "hand", baseUrl: "https://gw.example/claude", headers: { "x-m": "1" } },
    ],
  };

  it("of version 3 go into it, the key into its header, and nothing of them is lost", async () => {
    const { values, keys, open } = browser({ version: 3, services: [gateway], default: null });
    await keys.write("g", { key: "sk-gw-0123456789" });
    const ai = await open();
    await settle();
    const service = ai.serviceOf("g");
    expect(service).toMatchObject({
      baseUrl: "https://gw.example/v1",
      headers: { "x-team": "video", "api-key": "sk-gw-0123456789" },
    });
    expect(ai.modelOf("g", "m")?.config).toMatchObject({
      baseUrl: "https://gw.example/claude",
      headers: { "x-m": "1" },
    });
    // Which is a header like any other now: no key, and no header of its own for it.
    expect(service).not.toHaveProperty("keyHeader");
    expect(ai.getSnapshot().keyed.has("g")).toBe(false);
    expect(await keys.read("g")).toEqual({
      baseUrl: "https://gw.example/v1",
      headers: { "x-team": "video", "api-key": "sk-gw-0123456789" },
      models: { m: { baseUrl: "https://gw.example/claude", headers: { "x-m": "1" } } },
    });
    // The settings have none of it.
    const saved = JSON.stringify(values.get("ai"));
    expect(saved).not.toMatch(/gw\.example|x-team|x-m|api-key|keyHeader|sk-gw/);
    expect(JSON.stringify(values.get("ai.latest"))).not.toMatch(/gw\.example|sk-gw/);
    // Read again, by another window: the same.
    const again = await open();
    expect(again.serviceOf("g")).toMatchObject({
      baseUrl: "https://gw.example/v1",
      headers: { "x-team": "video", "api-key": "sk-gw-0123456789" },
    });
  });

  it("an Authorization of its own gets Bearer before the key", async () => {
    const { keys, open } = browser({
      version: 3,
      services: [{ ...gateway, keyHeader: "Authorization", headers: undefined, models: [] }],
    });
    await keys.write("g", { key: "sk-1" });
    const ai = await open();
    await settle();
    expect(ai.serviceOf("g")?.headers).toEqual({ Authorization: "Bearer sk-1" });
  });

  it("change apart from the settings, which every window hears of", async () => {
    const { values, keys, open } = browser();
    const one = await open();
    const two = await open();
    const id = one.add("openai-compatible", "网关", { baseUrl: "https://gw.example/v1" }) as string;
    await settle();
    one.update(id, { baseUrl: "https://other.example/v1", headers: { "x-a": "b" } });
    await settle();
    expect(await keys.read(id)).toEqual({
      baseUrl: "https://other.example/v1",
      headers: { "x-a": "b" },
    });
    expect(JSON.stringify(values.get("ai"))).not.toMatch(/example|x-a/);
    expect(two.serviceOf(id)).toMatchObject({
      baseUrl: "https://other.example/v1",
      headers: { "x-a": "b" },
    });
    // A key alone changes them too: the other window knows it has one.
    await one.setKey(id, "sk-new-0123456789");
    await settle();
    expect(two.getSnapshot().keyed.has(id)).toBe(true);
    expect((await keys.read(id))?.baseUrl).toBe("https://other.example/v1");
    // Taking all keys away leaves where the service is.
    await two.removeAllKeys();
    expect(await keys.read(id)).toEqual({
      baseUrl: "https://other.example/v1",
      headers: { "x-a": "b" },
    });
    // Taking the service away takes all of it.
    await one.remove(id);
    expect(await keys.read(id)).toBeUndefined();
  });
});

describe("moving what is secret where it cannot be kept (review of S-A2)", () => {
  const gateway = {
    id: "g",
    kind: "openai-compatible",
    name: "网关",
    baseUrl: "https://gw.example/v1",
    route: "direct",
    headers: { "x-team": "video" },
    keyHeader: "api-key",
    enabled: ["m"],
    models: [{ id: "m", added: "hand", baseUrl: "https://gw.example/claude" }],
  };

  it("leaves the settings with their addresses, and the key, until it can", async () => {
    const { values, keys, open } = browser({ version: 3, services: [gateway], default: null });
    await keys.write("g", { key: "sk-gw-0123456789" });
    const failing: KeyStore = {
      ...keys,
      update: async () => {
        throw new Error("quota");
      },
    };
    const ai = await open(failing);
    await settle();
    // Used as meant here, kept as it was there.
    expect(ai.serviceOf("g")).toMatchObject({
      baseUrl: "https://gw.example/v1",
      headers: { "x-team": "video", "api-key": "sk-gw-0123456789" },
    });
    expect(values.get("ai")).toMatchObject({ version: 3 });
    expect(JSON.stringify(values.get("ai"))).toContain("gw.example");
    expect(await keys.read("g")).toEqual({ key: "sk-gw-0123456789" });
    // The next time it can: moved, and the key with it.
    await open();
    await settle();
    expect(values.get("ai")).toMatchObject({ version: 4 });
    expect(await keys.read("g")).toMatchObject({ headers: { "api-key": "sk-gw-0123456789" } });
  });

  it("writes no settings without what is secret of them where that cannot be kept", async () => {
    const { values, keys, open } = browser();
    const ai = await open();
    const id = ai.add("openai-compatible", "网关", { baseUrl: "https://gw.example/v1" }) as string;
    await settle();
    const before = structuredClone(values.get("ai"));
    const failing: KeyStore = {
      ...keys,
      update: async () => {
        throw new Error("quota");
      },
    };
    const other = await open(failing);
    other.update(id, { baseUrl: "https://other.example/v1" });
    await settle();
    expect(values.get("ai")).toEqual(before);
    expect((await keys.read(id))?.baseUrl).toBe("https://gw.example/v1");
  });

  it("two windows moving the same settings at once both end with all of it", async () => {
    const { keys, open } = browser({ version: 3, services: [gateway], default: null });
    await keys.write("g", { key: "sk-gw-0123456789" });
    await Promise.all([open(), open()]);
    await settle();
    expect(await keys.read("g")).toMatchObject({
      baseUrl: "https://gw.example/v1",
      headers: { "api-key": "sk-gw-0123456789", "x-team": "video" },
    });
  });

  it("a key changed in one window and an address in another: both stay", async () => {
    const { keys, open } = browser();
    const one = await open();
    const id = one.add("openai-compatible", "网关", { baseUrl: "https://gw.example/v1" }) as string;
    await settle();
    const two = await open();
    await Promise.all([
      one.setKey(id, "sk-new-0123456789"),
      Promise.resolve(two.update(id, { baseUrl: "https://new.example/v1" })),
    ]);
    await settle();
    expect(await keys.read(id)).toEqual({
      key: "sk-new-0123456789",
      baseUrl: "https://new.example/v1",
    });
  });
});

describe("what reports leave out", () => {
  it("is every key, and where each service is and the values of its headers", async () => {
    const { open } = browser();
    const ai = await open();
    const id = ai.add("openai-compatible", "网关", {
      baseUrl: "https://secret-gateway.example/v1",
      headers: { "api-key": "THE-HEADER-SECRET" },
    }) as string;
    await ai.setKey(id, "sk-the-key-0123456789");
    await settle();
    for (const value of [
      "sk-the-key-0123456789",
      "https://secret-gateway.example/v1",
      "THE-HEADER-SECRET",
    ])
      expect(ai.knownKeys.has(value), value).toBe(true);
  });
});
