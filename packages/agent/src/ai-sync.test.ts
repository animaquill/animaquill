import { describe, expect, test } from "vitest";
import {
  EMPTY_AI_SETTINGS,
  readAiSettings,
  writeAiSettings,
  type AiSettings,
} from "./ai-settings.ts";
import {
  entriesOfPacks,
  entriesOfSettings,
  entryChanges,
  packsOfEntries,
  settingsOfEntries,
} from "./ai-sync.ts";

/** The AI settings as entries, to go with an account, and back. */

const settings: AiSettings = {
  ...EMPTY_AI_SETTINGS,
  services: [
    {
      id: "s-b",
      kind: "anthropic",
      name: "B",
      baseUrl: "https://api.anthropic.com",
      route: "direct",
      enabled: ["claude-opus-5", "claude-sonnet-5"],
    },
    {
      id: "s-a",
      kind: "deepseek",
      name: "A",
      baseUrl: "https://api.deepseek.com",
      route: "direct",
      enabled: ["deepseek-v4"],
      models: [
        { id: "mine", added: "hand", contextWindow: 64_000, edited: ["contextWindow"] },
        { id: "deepseek-v4", name: "V4", thinkingLevelMap: { off: null } },
      ],
    },
  ],
  default: { service: "s-a", model: "deepseek-v4" },
  reasoningFor: { "claude-opus-5": "high" },
  packFor: { "deepseek-v4": "animaquill/general" },
  maxToolCalls: 80,
  kept: { fields: { fromTheFuture: { a: 1 } } },
};

describe("entries of the AI settings", () => {
  test("each service, choice and field is an entry, and they come back as they were", () => {
    const written = writeAiSettings(settings);
    const entries = entriesOfSettings(written)!;
    expect([...entries.keys()].toSorted()).toEqual(
      [
        "service:s-b",
        "service:s-a",
        "model:s-a/mine",
        "model:s-a/deepseek-v4",
        "order",
        "default",
        "reasoning:claude-opus-5",
        "pack:deepseek-v4",
        "field:maxToolCalls",
        "field:autoTitle",
        "field:expandThinking",
        "field:fromTheFuture",
      ].toSorted(),
    );
    // What is worked out from the rest is not an entry.
    expect(entries.get("service:s-b")).not.toHaveProperty("model");
    // Each model is an entry of its own, not part of its service.
    expect(entries.get("service:s-a")).not.toHaveProperty("models");
    expect(entries.get("model:s-a/mine")).toEqual({
      id: "mine",
      added: "hand",
      contextWindow: 64_000,
      edited: ["contextWindow"],
    });
    const back = readAiSettings(settingsOfEntries(entries));
    expect(back.kind).toBe("ok");
    if (back.kind !== "ok") return;
    expect(back.from).toBe(3);
    expect(back.settings.services).toEqual(
      settings.services.map((service) => ({
        ...service,
        ...(service.models && {
          models: service.models.toSorted((a, b) => a.id.localeCompare(b.id)),
        }),
      })),
    );
  });

  test("two windows that each change a model of the same service keep both", () => {
    const base = entriesOfSettings(writeAiSettings(settings))!;
    const one = new Map(base).set("model:s-a/mine", { id: "mine", contextWindow: 32_000 });
    const two = new Map(base).set("model:s-a/deepseek-v4", { id: "deepseek-v4", name: "改过" });
    const merged = new Map(base);
    for (const side of [one, two])
      for (const [name, value] of entryChanges(base, side).changed) merged.set(name, value);
    const [, service] = settingsOfEntries(merged).services as { models: { id: string }[] }[];
    expect(service?.models).toEqual([
      { id: "deepseek-v4", name: "改过" },
      { id: "mine", contextWindow: 32_000 },
    ]);
  });

  test("models a page of version 2 wrote into a service still come, behind those of their own", () => {
    const entries = new Map<string, unknown>([
      [
        "service:s",
        {
          id: "s",
          kind: "deepseek",
          name: "D",
          baseUrl: "https://api.deepseek.com",
          route: "direct",
          enabled: ["a", "b"],
          models: [
            { id: "a", contextWindow: 1000 },
            { id: "b", contextWindow: 2000 },
          ],
        },
      ],
      ["model:s/a", { id: "a", contextWindow: 5000 }],
      ["order", ["s"]],
    ]);
    const saved = settingsOfEntries(entries);
    expect(saved.version).toBe(3);
    expect((saved.services as { models: unknown[] }[])[0]?.models).toEqual([
      { id: "a", contextWindow: 5000 },
      { id: "b", contextWindow: 2000 },
    ]);
    // And version 2's settings go as they were, models in the service.
    const two = entriesOfSettings({ ...writeAiSettings(settings), version: 2 })!;
    expect(two.has("model:s-a/mine")).toBe(false);
    expect(two.get("service:s-a")).toHaveProperty("models");
  });

  test("services in the order given, then those added elsewhere", () => {
    const entries = entriesOfSettings(writeAiSettings(settings))!;
    entries.set("service:s-c", { ...(entries.get("service:s-a") as object), id: "s-c" });
    const services = settingsOfEntries(entries).services as { id: string }[];
    expect(services.map(({ id }) => id)).toEqual(["s-b", "s-a", "s-c"]);
    entries.delete("service:s-b");
    expect((settingsOfEntries(entries).services as { id: string }[]).map(({ id }) => id)).toEqual([
      "s-a",
      "s-c",
    ]);
  });

  test("what is not settings of version 2 or 3 gives nothing, rather than everything gone", () => {
    for (const not of [
      undefined,
      null,
      [],
      { services: {} },
      { version: 4, services: [] },
      { services: [] },
    ])
      expect(entriesOfSettings(not), JSON.stringify(not)).toBeUndefined();
  });

  test("changes: new, other, gone; not the order of fields", () => {
    const before = new Map<string, unknown>([
      ["a", { x: 1, y: 2 }],
      ["b", 1],
      ["c", [1]],
    ]);
    const after = new Map<string, unknown>([
      ["a", { y: 2, x: 1 }],
      ["b", 2],
      ["d", null],
    ]);
    expect(entryChanges(before, after)).toEqual({
      changed: [
        ["b", 2],
        ["d", null],
      ],
      removed: ["c"],
    });
  });

  test("installed packs, by where they came from, in the order installed", () => {
    const one = {
      source: { kind: "github", url: "https://github.com/a/b", commit: "1" },
      files: {},
      installedAt: 2,
    };
    const two = { source: { kind: "folder", name: "mine" }, files: {}, installedAt: 1 };
    const entries = entriesOfPacks({ packs: [one, two] });
    expect([...entries.keys()]).toEqual([
      "installed:github:https://github.com/a/b",
      "installed:folder:mine",
    ]);
    expect(packsOfEntries(entries)).toEqual({ packs: [two, one] });
    expect(entriesOfPacks(undefined).size).toBe(0);
  });
});
