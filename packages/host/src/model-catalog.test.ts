// Adapted from pi-web (https://github.com/agegr/pi-web), lib/model-catalog.test.mjs, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.
import { describe, expect, test } from "vitest";
import { flattenModelsDev, readModelCatalog, recommendFromCatalog } from "./model-catalog.ts";

/** Which entry of models.dev a model people add is, and what of it can be taken. */

const catalog = flattenModelsDev({
  openai: {
    name: "OpenAI",
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: 400_000, output: 128_000 },
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
      },
      "gpt-image": {
        id: "gpt-image",
        modalities: { input: ["text"], output: ["image"] },
      },
    },
  },
  openrouter: {
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    models: {
      "openai/gpt-5": {
        id: "openai/gpt-5",
        name: "GPT-5 via OpenRouter",
        limit: { context: 400_000, output: 128_000 },
        cost: { input: 1.3, output: 10.5, cache_write: 2 },
      },
      "missing-price": {
        id: "missing-price",
        name: "No Price",
        limit: { context: 32_000, output: 8_000 },
      },
    },
  },
});

/** Providers that each have "model" at a price. */
function priceConsensusCatalog(
  groups: readonly { count: number; input: number; output: number }[],
) {
  let index = 0;
  return flattenModelsDev(
    Object.fromEntries(
      groups.flatMap(({ count, input, output }) =>
        Array.from({ length: count }, () => [
          `provider-${index++}`,
          {
            models: {
              model: {
                id: "model",
                cost: { input, output, cache_read: input / 10, cache_write: input },
              },
            },
          },
        ]),
      ),
    ),
  );
}

describe("the catalog of models.dev", () => {
  test("is flattened with only what is read: names, what it takes and gives, sizes, prices", () => {
    expect(catalog[0]).toEqual({
      providerId: "openai",
      providerName: "OpenAI",
      id: "gpt-5",
      name: "GPT-5",
      reasoning: true,
      image: true,
      efforts: ["low", "medium", "high"],
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 1.25, output: 10, cacheRead: 0.125 },
    });
    expect(catalog[1]).toMatchObject({ id: "gpt-image", chat: false, image: false });
    expect(catalog[3]?.cost).toEqual({});
    expect(catalog).toHaveLength(4);
    expect(flattenModelsDev("nothing")).toEqual([]);
    expect(readModelCatalog({ fetchedAt: 1, entries: catalog })?.entries).toHaveLength(4);
    expect(readModelCatalog({ entries: [] })).toBeUndefined();
  });

  test("takes the provider the service is, by its names", () => {
    const found = recommendFromCatalog(
      catalog,
      "openai/gpt-5",
      ["openrouter"],
      "https://proxy.example.com/v1",
    );
    expect(found.method).toBe("provider");
    expect(found.matchedProviderId).toBe("openrouter");
    expect(found.price).toEqual({
      status: "reliable",
      method: "provider",
      cost: { input: 1.3, output: 10.5, cacheRead: 0, cacheWrite: 2 },
      support: 1,
      total: 1,
    });
    // Without case, without `models/`, and the id without the provider.
    expect(recommendFromCatalog(catalog, "models/GPT-5", ["OpenAI"]).matchedProviderId).toBe(
      "openai",
    );
  });

  test("else by the host of the address, and not by one that only looks like it", () => {
    const openai = recommendFromCatalog(
      catalog,
      "openai/gpt-5",
      ["custom"],
      "https://api.openai.com/v1",
    );
    expect(openai.method).toBe("base-url");
    expect(openai.matchedProviderId).toBe("openai");
    expect(openai.price).toMatchObject({
      status: "reliable",
      method: "base-url",
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    });
    expect(
      recommendFromCatalog(catalog, "openai/gpt-5", ["custom"], "https://api.openrouter.ai/api/v1")
        .matchedProviderId,
    ).toBe("openrouter");
    expect(
      recommendFromCatalog(
        catalog,
        "openai/gpt-5",
        ["custom"],
        "https://openrouter.ai.example.com/v1",
      ).method,
    ).toBe("consensus");
  });

  test("else what most of them say, field by field, and the price where most agree", () => {
    const shared = (name: string, cost: object, more: object = {}) => ({
      models: {
        shared: {
          id: "shared",
          name,
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 128_000, output: 16_000 },
          cost,
          ...more,
        },
      },
    });
    const found = recommendFromCatalog(
      flattenModelsDev({
        alpha: shared("Shared Model", { input: 2, output: 8, cache_read: 0.2, cache_write: 2 }),
        beta: shared("Shared Model", { input: 2, output: 8, cache_read: 0.2, cache_write: 2 }),
        delta: shared("Shared Model", { input: 2, output: 8, cache_read: 0.3, cache_write: 3 }),
        gamma: {
          models: {
            shared: {
              id: "shared",
              name: "Other Name",
              reasoning: false,
              modalities: { input: ["text"] },
              limit: { context: 64_000, output: 8_000 },
              cost: { input: 3, output: 9, cache_read: 0.4, cache_write: 4 },
            },
          },
        },
      }),
      "shared",
      ["custom"],
    );
    expect(found.method).toBe("consensus");
    expect(found.preset).toEqual({
      name: "Shared Model",
      reasoning: true,
      image: true,
      contextWindow: 128_000,
      maxTokens: 16_000,
      cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
    });
    expect(found.price).toEqual({
      status: "reliable",
      method: "consensus",
      cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
      support: 3,
      total: 4,
    });
  });

  test("takes a plurality of five below 60%, never one of four, nor a tie", () => {
    expect(
      recommendFromCatalog(
        priceConsensusCatalog([
          { count: 5, input: 1, output: 2 },
          { count: 4, input: 3, output: 4 },
          { count: 3, input: 5, output: 6 },
          { count: 2, input: 7, output: 8 },
          { count: 2, input: 9, output: 10 },
          { count: 2, input: 11, output: 12 },
          { count: 2, input: 13, output: 14 },
        ]),
        "model",
      ).price,
    ).toEqual({
      status: "reliable",
      method: "consensus",
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      support: 5,
      total: 20,
    });
    expect(
      recommendFromCatalog(
        priceConsensusCatalog([
          { count: 4, input: 1, output: 2 },
          { count: 3, input: 3, output: 4 },
          { count: 2, input: 5, output: 6 },
          { count: 1, input: 7, output: 8 },
        ]),
        "model",
      ).price,
    ).toEqual({ status: "unreliable", reason: "conflict", support: 4, total: 10 });
    expect(
      recommendFromCatalog(
        priceConsensusCatalog([
          { count: 5, input: 1, output: 2 },
          { count: 5, input: 3, output: 4 },
        ]),
        "model",
      ).price,
    ).toEqual({ status: "unreliable", reason: "conflict", support: 5, total: 10 });
  });

  test("refuses a price two of four say against two, or only one says, and fills no price then", () => {
    const conflict = recommendFromCatalog(
      flattenModelsDev({
        a: { models: { model: { id: "model", cost: { input: 1, output: 2 } } } },
        b: { models: { model: { id: "model", cost: { input: 1, output: 2 } } } },
        c: { models: { model: { id: "model", cost: { input: 3, output: 4 } } } },
        d: { models: { model: { id: "model", cost: { input: 3, output: 4 } } } },
      }),
      "model",
    );
    expect(conflict.price).toEqual({
      status: "unreliable",
      reason: "conflict",
      support: 2,
      total: 4,
    });
    expect(conflict.preset.cost).toBeUndefined();
    const single = recommendFromCatalog(
      flattenModelsDev({
        only: { models: { model: { id: "model", cost: { input: 1, output: 2 } } } },
      }),
      "model",
    );
    expect(single.price).toMatchObject({ status: "unreliable", reason: "insufficient-support" });
  });

  test("says when it does not know the model at all", () => {
    expect(recommendFromCatalog(catalog, "my-finetune")).toEqual({
      exactMatches: 0,
      method: "none",
      preset: {},
      price: { status: "unreliable", reason: "no-exact-match", support: 0, total: 0 },
    });
  });
});
