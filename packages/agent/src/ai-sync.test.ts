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
      models: [{ id: "mine", contextWindow: 64_000 }],
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
    const back = readAiSettings(settingsOfEntries(entries));
    expect(back.kind).toBe("ok");
    if (back.kind !== "ok") return;
    expect(back.from).toBe(2);
    expect(writeAiSettings(back.settings)).toEqual(written);
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

  test("what is not settings of version 2 gives nothing, rather than everything gone", () => {
    for (const not of [
      undefined,
      null,
      [],
      { services: {} },
      { version: 3, services: [] },
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
