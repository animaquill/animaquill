import { COMPARISON_PACK_ID } from "@animaquill/tools";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOOL_CALLS,
  EMPTY_AI_SETTINGS,
  enabledCountOf,
  enabledModelsOf,
  readAiSettings,
  settledDefault,
  writeAiSettings,
  type AiSettings,
} from "./ai-settings.ts";

const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** A service as version 1 (until 0.3.55) saved it. */
const v1Service = (id: string, kind: string, model: string, more: object = {}) => ({
  id,
  kind,
  name: id.toUpperCase(),
  baseUrl: `https://${id}.example`,
  model,
  route: "direct",
  ...more,
});

function settingsOf(value: unknown): AiSettings {
  const reading = readAiSettings(value);
  if (reading.kind !== "ok") throw new Error(`not read: ${reading.kind}`);
  return reading.settings;
}

describe("AI settings of version 1", () => {
  it("turn each service's model on, and the one in use becomes the default", () => {
    const reading = readAiSettings({
      services: [v1Service("a", "anthropic", "claude-opus-5-5"), v1Service("b", "deepseek", "")],
      current: "a",
      maxToolCalls: 80,
    });
    expect(reading).toMatchObject({ kind: "ok", from: 1 });
    const settings = settingsOf({
      services: [v1Service("a", "anthropic", "claude-opus-5-5"), v1Service("b", "deepseek", "")],
      current: "a",
      maxToolCalls: 80,
    });
    expect(settings.services).toEqual([
      {
        id: "a",
        kind: "anthropic",
        name: "A",
        baseUrl: "https://a.example",
        route: "direct",
        enabled: ["claude-opus-5-5"],
      },
      {
        id: "b",
        kind: "deepseek",
        name: "B",
        baseUrl: "https://b.example",
        route: "direct",
        enabled: [],
      },
    ]);
    expect(settings.default).toEqual({ service: "a", model: "claude-opus-5-5" });
    expect(settings.maxToolCalls).toBe(80);
    expect(settings.autoTitle).toBe(true);
    expect(settings.expandThinking).toBe(false);
  });

  it("take the first model that is on where the service in use has none, or is not there", () => {
    const services = [
      v1Service("a", "anthropic", ""),
      v1Service("b", "deepseek", "deepseek-flash"),
    ];
    expect(settingsOf({ services, current: "a" }).default).toEqual({
      service: "b",
      model: "deepseek-flash",
    });
    expect(settingsOf({ services, current: "gone" }).default?.service).toBe("b");
    expect(settingsOf({ services }).default?.service).toBe("b");
    expect(settingsOf({ services: [v1Service("a", "anthropic", "")] }).default).toBeUndefined();
    expect(settingsOf({ services: [] })).toMatchObject({
      services: [],
      default: undefined,
      maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
    });
  });

  it("keep the packs people chose, and whether hidden ones show", () => {
    const settings = settingsOf({
      services: [v1Service("a", "anthropic", "claude-opus-5-5")],
      current: "a",
      showHiddenPacks: true,
      packFor: { "claude-opus-5-5": "lin/steady", "": "x/y", other: "NOT AN ID" },
    });
    expect(settings.showHiddenPacks).toBe(true);
    expect(settings.packFor).toEqual({ "claude-opus-5-5": "lin/steady" });
  });

  it("turn the switch of the words to compare with into that pack, for each model that was on", () => {
    const settings = settingsOf({
      services: [
        v1Service("a", "anthropic", "claude-opus-5-5"),
        v1Service("b", "deepseek", "deepseek-flash"),
        v1Service("c", "openai", ""),
      ],
      current: "a",
      comparisonTexts: true,
      packFor: { "deepseek-flash": "lin/steady" },
    });
    expect(settings.showHiddenPacks).toBe(true);
    // What people chose stays theirs.
    expect(settings.packFor).toEqual({
      "claude-opus-5-5": COMPARISON_PACK_ID,
      "deepseek-flash": "lin/steady",
    });
    // The old key stays, for a page of before.
    expect(writeAiSettings(settings).comparisonTexts).toBe(true);
    // Once written as version 2, it is not read as the switch again.
    const again = settingsOf({ ...writeAiSettings(settings), packFor: {} });
    expect(again.packFor).toBeUndefined();
  });

  it("keep services that cannot be read, without anything that could be a key", () => {
    const value = {
      services: [
        v1Service("a", "anthropic", "claude-opus-5-5"),
        v1Service("b", "nope", "m"),
        { id: "c", kind: "deepseek", name: "C", baseUrl: "https://x", model: "", key: KEY },
        "not a service",
        v1Service("a", "deepseek", "twice"),
      ],
      current: "b",
      maxToolCalls: 100000,
    };
    const settings = settingsOf(value);
    expect(settings.services.map(({ id }) => id)).toEqual(["a"]);
    expect(settings.default).toEqual({ service: "a", model: "claude-opus-5-5" });
    expect(settings.maxToolCalls).toBe(500);
    const written = writeAiSettings(settings);
    expect(written.services).toEqual([
      expect.objectContaining({ id: "a", enabled: ["claude-opus-5-5"], model: "claude-opus-5-5" }),
      v1Service("b", "nope", "m"),
      { id: "c", kind: "deepseek", name: "C", baseUrl: "https://x", model: "" },
      "not a service",
      v1Service("a", "deepseek", "twice"),
    ]);
    expect(JSON.stringify(written)).not.toContain(KEY);
  });

  it("are not settings unless they have services", () => {
    expect(readAiSettings("x")).toEqual({ kind: "broken" });
    expect(readAiSettings({ services: "a" })).toEqual({ kind: "broken" });
    expect(readAiSettings(undefined)).toEqual({ kind: "broken" });
  });
});

describe("AI settings of version 2", () => {
  const two = {
    version: 2,
    services: [
      {
        id: "a",
        kind: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        route: "direct",
        enabled: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5-5", 3, ""],
        models: [
          { id: "claude-test", contextWindow: 64000 },
          { id: "" },
          { id: "x", contextWindow: -1 },
        ],
        model: "claude-opus-5-5",
      },
    ],
    default: { service: "a", model: "claude-sonnet-5-5" },
    current: "a",
    reasoningFor: { "claude-opus-5-5": "high", "claude-sonnet-5-5": "huge" },
    maxToolCalls: 70,
    autoTitle: false,
    expandThinking: true,
  };

  it("read back what was written", () => {
    const reading = readAiSettings(two);
    expect(reading).toMatchObject({ kind: "ok", from: 2 });
    const settings = settingsOf(two);
    expect(settings.services[0]).toMatchObject({
      enabled: ["claude-opus-5-5", "claude-sonnet-5-5"],
      models: [{ id: "claude-test", contextWindow: 64000 }, { id: "x" }],
    });
    expect(settings.default).toEqual({ service: "a", model: "claude-sonnet-5-5" });
    expect(settings.reasoningFor).toEqual({ "claude-opus-5-5": "high" });
    expect(settings).toMatchObject({ maxToolCalls: 70, autoTitle: false, expandThinking: true });
    expect(settingsOf(writeAiSettings(settings))).toEqual(settings);
  });

  it("write what a page of version 1 reads: the service in use and its model", () => {
    const written = writeAiSettings(settingsOf(two));
    expect(written.current).toBe("a");
    expect(written.services).toEqual([
      expect.objectContaining({ id: "a", model: "claude-sonnet-5-5", route: "direct" }),
    ]);
  });

  it("keep fields they do not know, in the settings and in services", () => {
    const value = {
      ...two,
      later: { something: 1 },
      apiKey: KEY,
      services: [{ ...two.services[0], color: "red", token: KEY }],
    };
    const written = writeAiSettings(settingsOf(value));
    expect(written.later).toEqual({ something: 1 });
    expect(written.services).toEqual([expect.objectContaining({ color: "red" })]);
    expect(JSON.stringify(written)).not.toContain(KEY);
  });

  it("take a model that is on as the default where the one written is not", () => {
    const off = { ...two, default: { service: "a", model: "claude-haiku-5-5" } };
    expect(settingsOf(off).default).toEqual({ service: "a", model: "claude-opus-5-5" });
    const gone = { ...two, default: { service: "b", model: "claude-opus-5-5" } };
    expect(settingsOf(gone).default?.service).toBe("a");
  });

  it("are left alone when a newer editor wrote them", () => {
    expect(readAiSettings({ ...two, version: 3 })).toEqual({ kind: "newer" });
    expect(readAiSettings({ ...two, version: "2.1" })).toEqual({ kind: "newer" });
  });

  it("count and list the models that are on", () => {
    const settings: AiSettings = {
      ...EMPTY_AI_SETTINGS,
      services: [
        {
          id: "a",
          kind: "anthropic",
          name: "A",
          baseUrl: "",
          route: "direct",
          enabled: ["m", "n"],
        },
        { id: "b", kind: "anthropic", name: "B", baseUrl: "", route: "direct", enabled: ["m"] },
      ],
    };
    expect(enabledCountOf(settings)).toBe(3);
    expect(enabledModelsOf(settings)).toEqual(["m", "n"]);
    expect(settledDefault(settings.services, { service: "b", model: "n" })).toEqual({
      service: "a",
      model: "m",
    });
  });
});
