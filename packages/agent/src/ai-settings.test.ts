import { COMPARISON_PACK_ID } from "@animaquill/tools";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_TOOL_CALLS,
  EMPTY_AI_SETTINGS,
  enabledCountOf,
  enabledModelsOf,
  isSecretName,
  readAiSettings,
  recoverOldWrite,
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

describe("a page of version 1 that wrote over version 2", () => {
  const latest = settingsOf({
    version: 2,
    services: [
      {
        id: "a",
        kind: "anthropic",
        name: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        route: "direct",
        enabled: ["claude-opus-5-5", "claude-sonnet-5-5"],
        models: [{ id: "claude-mine", contextWindow: 64000 }],
      },
      {
        id: "b",
        kind: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        route: "direct",
        enabled: ["deepseek-flash", "deepseek-v4-pro"],
      },
    ],
    default: { service: "a", model: "claude-sonnet-5-5" },
    reasoningFor: { "claude-opus-5-5": "high" },
    packFor: { "deepseek-flash": "lin/steady" },
    autoTitle: false,
  });
  /** What that page writes: what it read of version 2, as version 1, with its changes. */
  const oldWrite = (change: (value: Record<string, unknown>) => void = () => {}) => {
    const value = structuredClone(writeAiSettings(latest)) as Record<string, unknown> & {
      services: Record<string, unknown>[];
    };
    value.services = value.services.map(({ id, kind, name, baseUrl, model, route }) => ({
      id,
      kind,
      name,
      baseUrl,
      model,
      route,
    }));
    for (const field of ["version", "default", "reasoningFor", "autoTitle", "expandThinking"]) {
      delete value[field];
    }
    change(value);
    return value;
  };

  it("loses nothing of version 2 where it changed nothing", () => {
    expect(recoverOldWrite(latest, oldWrite())).toEqual(latest);
  });

  it("keeps what it changed: names, addresses, a model picked, the limit, packs", () => {
    const recovered = recoverOldWrite(
      latest,
      oldWrite((value) => {
        const [a, b] = value.services as Record<string, unknown>[];
        if (!a || !b) throw new Error("no services");
        a.name = "公司的 Anthropic";
        a.model = "claude-haiku-5-5";
        b.baseUrl = "https://proxy.example";
        value.maxToolCalls = 9;
        value.packFor = {};
      }),
    );
    expect(recovered?.services[0]).toMatchObject({
      name: "公司的 Anthropic",
      enabled: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
      models: [{ id: "claude-mine", contextWindow: 64000 }],
    });
    expect(recovered?.services[1]).toMatchObject({
      baseUrl: "https://proxy.example",
      enabled: ["deepseek-flash", "deepseek-v4-pro"],
    });
    // The model picked in the service in use is the default now.
    expect(recovered?.default).toEqual({ service: "a", model: "claude-haiku-5-5" });
    expect(recovered).toMatchObject({
      maxToolCalls: 9,
      reasoningFor: { "claude-opus-5-5": "high" },
      autoTitle: false,
    });
    expect(recovered?.packFor).toBeUndefined();
  });

  it("keeps services it added or took away, and another one in use", () => {
    const recovered = recoverOldWrite(
      latest,
      oldWrite((value) => {
        const services = value.services as Record<string, unknown>[];
        value.services = [
          services[1],
          {
            id: "c",
            kind: "openai",
            name: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-6.1-sol",
            route: "direct",
          },
        ];
        value.current = "c";
      }),
    );
    expect(recovered?.services.map(({ id, enabled }) => [id, enabled])).toEqual([
      ["b", ["deepseek-flash", "deepseek-v4-pro"]],
      ["c", ["gpt-6.1-sol"]],
    ]);
    expect(recovered?.default).toEqual({ service: "c", model: "gpt-6.1-sol" });
  });

  it("is only for version 1", () => {
    expect(recoverOldWrite(latest, writeAiSettings(latest))).toBeUndefined();
    expect(recoverOldWrite(latest, "x")).toBeUndefined();
  });
});

describe("review of CM1: what a page of version 1 never saw, and names of secrets", () => {
  const base = {
    version: 2,
    services: [
      {
        id: "a",
        kind: "anthropic",
        name: "A",
        baseUrl: "https://api.anthropic.com",
        route: "direct",
        enabled: ["m1", "m2"],
      },
      {
        id: "b",
        kind: "deepseek",
        name: "B",
        baseUrl: "https://api.deepseek.com",
        route: "direct",
        enabled: ["d1", "d2"],
      },
    ],
    default: { service: "a", model: "m2" },
  };
  /** What a page of version 1 writes after reading what version 2 wrote: only what it knows. */
  const oldWriteOf = (
    latest: AiSettings,
    change: (
      value: Record<string, unknown> & { services: Record<string, unknown>[] },
    ) => void = () => {},
  ) => {
    const written = structuredClone(writeAiSettings(latest)) as Record<string, unknown> & {
      services: Record<string, unknown>[];
    };
    const value = {
      services: written.services
        .filter((service) => ["anthropic", "deepseek", "openai"].includes(String(service.kind)))
        .map(({ id, kind, name, baseUrl, model, route }) => ({
          id,
          kind,
          name,
          baseUrl,
          model,
          route,
        })),
      current: written.current,
      maxToolCalls: written.maxToolCalls,
      ...(written.packFor !== undefined && { packFor: written.packFor }),
      ...(written.showHiddenPacks !== undefined && { showHiddenPacks: written.showHiddenPacks }),
    };
    change(value);
    return value;
  };

  it("keeps services and fields neither version understands", () => {
    const latest = settingsOf({
      ...base,
      services: [
        ...base.services,
        {
          id: "x",
          kind: "from-later",
          name: "X",
          baseUrl: "https://x",
          route: "direct",
          enabled: ["q"],
        },
      ],
      laterField: { a: 1 },
    });
    expect(latest.kept?.services).toHaveLength(1);
    const recovered = recoverOldWrite(latest, oldWriteOf(latest));
    const written = writeAiSettings(recovered as AiSettings);
    expect((written.services as { id: string }[]).map(({ id }) => id)).toContain("x");
    expect(written.laterField).toEqual({ a: 1 });
  });

  it("takes only what differs from what that page read", () => {
    const latest = settingsOf({
      ...base,
      services: [{ ...base.services[0], name: "Renamed" }, base.services[1]],
      maxToolCalls: 70,
    });
    const recovered = recoverOldWrite(
      latest,
      oldWriteOf(latest, (value) => {
        const second = value.services[1];
        if (second) second.route = "relay";
      }),
    );
    expect(recovered?.services.map(({ name, route }) => [name, route])).toEqual([
      ["Renamed", "direct"],
      ["B", "relay"],
    ]);
    expect(recovered?.maxToolCalls).toBe(70);
  });

  it("comes to the same twice, as two windows of version 2 take the same write", () => {
    const latest = settingsOf(base);
    const changed = oldWriteOf(latest, (value) => {
      const second = value.services[1];
      if (second) second.model = "d1";
      value.current = "b";
    });
    const once = recoverOldWrite(latest, changed) as AiSettings;
    expect(recoverOldWrite(once, changed)).toEqual(once);
  });

  it("keeps the packs where the page is older than packs", () => {
    const latest = settingsOf({ ...base, packFor: { m1: "lin/steady" }, showHiddenPacks: true });
    const recovered = recoverOldWrite(
      latest,
      oldWriteOf(latest, (value) => {
        delete value.packFor;
        delete value.showHiddenPacks;
      }),
    );
    expect(recovered?.packFor).toEqual({ m1: "lin/steady" });
    expect(recovered?.showHiddenPacks).toBe(true);
  });

  it("keeps fields named like tokens of a model, never those of secrets, however deep", () => {
    const settings = settingsOf({
      ...base,
      services: [
        { ...base.services[0], maxTokens: 4096, authType: "bearer", apiKey: "sk-xxx" },
        base.services[1],
        { id: "x", kind: "from-later", headers: { Authorization: "Bearer sk-zzz", Accept: "a" } },
      ],
      maxOutputTokens: 100,
      tokenBudget: 5,
      refresh_token: "sk-yyy",
    });
    const written = writeAiSettings(settings) as Record<string, unknown> & {
      services: Record<string, unknown>[];
    };
    expect(written.services[0]).toMatchObject({ maxTokens: 4096, authType: "bearer" });
    expect(written.services[2]).toEqual({ id: "x", kind: "from-later", headers: { Accept: "a" } });
    expect(written).toMatchObject({ maxOutputTokens: 100, tokenBudget: 5 });
    expect(JSON.stringify(written)).not.toMatch(/sk-(xxx|yyy|zzz)/);
    for (const name of ["key", "apiKey", "api_key", "token", "accessToken", "secret", "password"]) {
      expect(isSecretName(name), name).toBe(true);
    }
    for (const name of ["maxTokens", "authType", "keyHint", "tokenBudget", "monkey"]) {
      expect(isSecretName(name), name).toBe(false);
    }
  });
});
