import { COMPARISON_PACK_ID } from "@animaquill/tools";
import { describe, expect, it } from "vitest";
import {
  AI_SETTINGS_VERSION,
  DEFAULT_MAX_TOOL_CALLS,
  EMPTY_AI_SETTINGS,
  headerProblem,
  keyIntoHeader,
  enabledCountOf,
  enabledModelsOf,
  isSecretName,
  readAiSettings,
  recoverOldWrite,
  secretsOf,
  settledDefault,
  favoritesOf,
  withSecrets,
  writeAiSettings,
  type AiSettings,
} from "./ai-settings.ts";
import { entriesOfSettings } from "./ai-sync.ts";
import { settingsOfEntries as settingsOfEntriesThen } from "./ai-sync-0363.test-support.ts";

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

/** Settings as they are saved and read again, with what is secret of each service kept apart. */
function roundTrip(settings: AiSettings): AiSettings {
  const secrets = secretsOf(settings);
  return withSecrets(settingsOf(writeAiSettings(settings)), (id) => secrets.get(id));
}

/**
 * Settings as written, with the address of each service in it, as versions before 4 wrote them,
 * which the pages of before read.
 */
function withAddresses(written: Record<string, unknown>, settings: AiSettings) {
  return {
    ...written,
    services: (written.services as Record<string, unknown>[]).map((service) => {
      const known = settings.services.find(({ id }) => id === service.id);
      return known ? { ...service, baseUrl: known.baseUrl } : service;
    }),
  };
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
    expect(settings.sendWith).toBeUndefined();
    expect(roundTrip(settings)).toEqual(settings);
  });

  it("send with Ctrl+Enter only where people chose it, and nothing else said for it", () => {
    const chosen = settingsOf({ ...two, sendWith: "modEnter" });
    expect(chosen.sendWith).toBe("modEnter");
    expect(writeAiSettings(chosen).sendWith).toBe("modEnter");
    expect(roundTrip(chosen)).toEqual(chosen);
    for (const other of ["enter", "ctrl", 1, null]) {
      const read = settingsOf({ ...two, sendWith: other });
      expect(read.sendWith, String(other)).toBeUndefined();
      expect("sendWith" in writeAiSettings(read), String(other)).toBe(false);
      expect(read.kept?.fields?.sendWith, String(other)).toBeUndefined();
    }
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
    expect(readAiSettings({ ...two, version: 5 })).toEqual({ kind: "newer" });
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
    const value = structuredClone(withAddresses(writeAiSettings(latest), latest)) as Record<
      string,
      unknown
    > & {
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

  it("is only for pages of before", () => {
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
    const written = structuredClone(withAddresses(writeAiSettings(latest), latest)) as Record<
      string,
      unknown
    > & {
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

describe("AI settings of version 3", () => {
  const full = {
    version: 3,
    services: [
      {
        id: "g",
        kind: "openai-compatible",
        name: "公司网关",
        baseUrl: "https://gateway.example/v1",
        route: "direct",
        api: "anthropic-messages",
        headers: { "x-team": "video", "x-api-key": KEY, Cookie: "a=b", "bad name": "x" },
        enabled: ["team-claude"],
        models: [
          {
            id: "team-claude",
            added: "service",
            name: "Team Claude",
            reasoning: true,
            image: true,
            contextWindow: 200000,
            maxTokens: 64000,
            imageMaxBytes: 5242880,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            baseUrl: "https://gateway.example/claude",
            api: "anthropic-messages",
            headers: { "x-route": "a" },
            compat: { forceAdaptiveThinking: true, supportsDeveloperRole: false, other: 1 },
            thinkingLevelMap: { off: null, high: "max", xhigh: "xhigh", low: "far too long value" },
            filled: {
              from: ["service", "models.dev", "nowhere"],
              by: "consensus",
              matched: "Anthropic",
              priceDoubt: "conflict",
              fields: ["contextWindow", "thinking.high", "nope"],
              snapshot: { contextWindow: 128000, password: KEY },
            },
            edited: ["name", "cost", "x"],
            future: { a: 1 },
          },
          { id: "team-claude" },
          { id: "broken", contextWindow: -5, cost: { input: 1 }, api: "smoke", baseUrl: "ftp://x" },
        ],
        paused: ["old"],
        model: "team-claude",
      },
    ],
    default: { service: "g", model: "team-claude" },
  };

  it("keep everything of each model, and of a server of one's own, field by field", () => {
    expect(AI_SETTINGS_VERSION).toBe(4);
    const reading = readAiSettings(full);
    expect(reading).toMatchObject({ kind: "ok", from: 3 });
    const [service] = settingsOf(full).services;
    expect(service).toMatchObject({ api: "anthropic-messages" });
    // Named like a key is people's own; of the browser, or not a name, is not.
    expect(service?.headers).toEqual({ "x-team": "video", "x-api-key": KEY });
    // Paused models are of a service that is all off: this one has one on.
    expect(service?.paused).toBeUndefined();
    expect(service?.models).toEqual([
      {
        id: "team-claude",
        added: "service",
        name: "Team Claude",
        reasoning: true,
        image: true,
        contextWindow: 200000,
        maxTokens: 64000,
        imageMaxBytes: 5242880,
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        baseUrl: "https://gateway.example/claude",
        api: "anthropic-messages",
        headers: { "x-route": "a" },
        compat: { forceAdaptiveThinking: true, supportsDeveloperRole: false },
        thinkingLevelMap: { off: null, high: "max", xhigh: "xhigh" },
        filled: {
          from: ["service", "models.dev"],
          by: "consensus",
          matched: "Anthropic",
          priceDoubt: "conflict",
          fields: ["contextWindow", "thinking.high"],
          snapshot: { contextWindow: 128000 },
        },
        edited: ["name", "cost"],
      },
      { id: "broken" },
    ]);
    expect(reading).toMatchObject({ inline: true });
    const written = writeAiSettings(settingsOf(full));
    expect(written.version).toBe(4);
    // What this editor does not know of a model goes back as it was.
    expect(
      (written.services as { models: Record<string, unknown>[] }[])[0]?.models[0],
    ).toMatchObject({ future: { a: 1 } });
    // Addresses and headers are not in it: they are secret, and kept apart with the key.
    expect(JSON.stringify(written)).not.toMatch(/gateway\.example|x-team|x-route/);
    expect(secretsOf(settingsOf(full)).get("g")).toEqual({
      baseUrl: "https://gateway.example/v1",
      headers: { "x-team": "video", "x-api-key": KEY },
      models: {
        "team-claude": { baseUrl: "https://gateway.example/claude", headers: { "x-route": "a" } },
      },
    });
    expect(readAiSettings(written)).toMatchObject({ kind: "ok", from: 4 });
    expect(readAiSettings(written)).not.toHaveProperty("inline");
    expect(roundTrip(settingsOf(full))).toEqual(settingsOf(full));
  });

  it("let only servers of one's own say how they are talked to", () => {
    const anthropic = {
      ...full,
      services: [{ ...full.services[0], kind: "anthropic", api: "openai-responses" }],
    };
    expect(settingsOf(anthropic).services[0]?.api).toBeUndefined();
  });

  it("keep the models that were on as the whole service went off", () => {
    const off = { ...full, services: [{ ...full.services[0], enabled: [] }] };
    expect(settingsOf(off).services[0]?.paused).toEqual(["old"]);
  });

  it("read version 2's models people named as theirs, with the size they gave", () => {
    const [service] = settingsOf({
      version: 2,
      services: [
        {
          id: "a",
          kind: "deepseek",
          name: "D",
          baseUrl: "https://api.deepseek.com",
          route: "direct",
          enabled: ["mine", "deepseek-flash"],
          models: [{ id: "mine", contextWindow: 64000 }, { id: "other" }],
        },
      ],
    }).services;
    expect(service?.models).toEqual([
      { id: "mine", added: "hand", contextWindow: 64000, edited: ["contextWindow"] },
      { id: "other", added: "hand" },
    ]);
    expect(service?.enabled).toEqual(["mine", "deepseek-flash"]);
  });

  it("take any header of people's own, named as they like, with values fetch can send", () => {
    expect(headerProblem("x-team", "video")).toBeUndefined();
    // Gateways name their key headers as they like: those are people's own to give.
    for (const name of ["api-key", "Ocp-Apim-Subscription-Key", "x-session-affinity", "x-api-key"])
      expect(headerProblem(name, "x"), name).toBeUndefined();
    expect(headerProblem("Host", "x")).toBe("name");
    expect(headerProblem("x-forwarded-for", "x")).toBe("name");
    expect(headerProblem("true-client-ip", "x")).toBe("name");
    expect(headerProblem("aq-pass-x", "x")).toBe("name");
    expect(headerProblem("x-animaquill-admin", "x")).toBe("name");
    expect(headerProblem("bad name", "x")).toBe("name");
    // Only what fetch takes: Latin letters, digits and signs.
    expect(headerProblem("x-team", "a\nb")).toBe("value");
    expect(headerProblem("x-team", "视频")).toBe("value");
    expect(headerProblem("x-team", "é")).toBe("value");
    expect(() => new Headers({ "x-team": "video-1 a=b" })).not.toThrow();
    // Headers the browser or the platform keep for themselves.
    for (const name of ["Set-Cookie", "User-Agent", "Cookie", "Host"])
      expect(headerProblem(name, "x"), name).toBe("name");
    // Read, what cannot be sent is left out, and said so; and only so many.
    const reading = readAiSettings({
      ...full,
      services: [
        {
          ...full.services[0],
          headers: {
            "x-team": "视频",
            ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x-h${i}`, "v"])),
          },
        },
      ],
    });
    expect(reading).toMatchObject({ kind: "ok", headersLeftOut: true });
    if (reading.kind === "ok")
      expect(Object.keys(reading.settings.services[0]?.headers ?? {})).toHaveLength(32);
    expect(
      readAiSettings({ ...full, services: [{ ...full.services[0], headers: { "x-team": "v" } }] }),
    ).not.toHaveProperty("headersLeftOut");
  });

  it("say the header a server of one's own took its key in, to go into its headers; no address with a secret", () => {
    const azure = {
      ...full,
      services: [
        {
          ...full.services[0],
          keyHeader: "api-key",
          models: [
            { id: "a", baseUrl: "https://x.example/v1?api_key=sk" },
            { id: "b", baseUrl: "https://user:pass@x.example/v1" },
            { id: "c", baseUrl: "https://x.example/v1" },
          ],
        },
      ],
    };
    const reading = readAiSettings(azure);
    expect(reading).toMatchObject({ kind: "ok", keyHeaders: { g: "api-key" } });
    const [service] = settingsOf(azure).services;
    expect(service).not.toHaveProperty("keyHeader");
    expect(service?.models?.map((model) => model.baseUrl)).toEqual([
      undefined,
      undefined,
      "https://x.example/v1",
    ]);
    expect(JSON.stringify(writeAiSettings(settingsOf(azure)))).not.toContain("keyHeader");
    // Only servers of one's own had a header of their own for the key.
    const other = { ...azure, services: [{ ...azure.services[0], kind: "openai" }] };
    expect(readAiSettings(other)).not.toHaveProperty("keyHeaders");
    // The key goes in it, after Bearer where the header is Authorization.
    expect(keyIntoHeader({ "x-team": "v" }, "api-key", "sk-1")).toEqual({
      "x-team": "v",
      "api-key": "sk-1",
    });
    expect(keyIntoHeader({ authorization: "old" }, "Authorization", "sk-1")).toEqual({
      Authorization: "Bearer sk-1",
    });
  });
});

describe("a page of version 2 that wrote over version 3", () => {
  const latest = settingsOf({
    version: 3,
    services: [
      {
        id: "g",
        kind: "openai-compatible",
        name: "网关",
        baseUrl: "https://gateway.example/v1",
        route: "direct",
        api: "anthropic-messages",
        headers: { "x-team": "video" },
        enabled: ["team-claude", "mine"],
        models: [
          {
            id: "team-claude",
            added: "service",
            maxTokens: 1000,
            filled: { from: ["models.dev"], fields: ["maxTokens"], snapshot: {} },
          },
          { id: "mine", added: "hand", contextWindow: 64000, edited: ["contextWindow"] },
          { id: "gone", added: "hand" },
        ],
      },
    ],
  });

  it("takes what it changed and keeps what only version 3 has", () => {
    // What that page read, before version 3, and wrote with a change: a name, a size, one gone.
    const old = {
      version: 2,
      services: [
        {
          id: "g",
          kind: "openai-compatible",
          name: "网关（改名）",
          baseUrl: "https://gateway.example/v1",
          route: "direct",
          enabled: ["team-claude", "mine"],
          models: [
            { id: "team-claude", contextWindow: 128000 },
            { id: "mine", contextWindow: 32000 },
          ],
          model: "team-claude",
        },
      ],
      default: { service: "g", model: "mine" },
    };
    const recovered = recoverOldWrite(latest, old);
    expect(recovered?.default).toEqual({ service: "g", model: "mine" });
    const [service] = recovered?.services ?? [];
    expect(service).toMatchObject({
      name: "网关（改名）",
      api: "anthropic-messages",
      headers: { "x-team": "video" },
    });
    expect(service?.models).toEqual([
      {
        id: "team-claude",
        added: "service",
        maxTokens: 1000,
        contextWindow: 128000,
        edited: ["contextWindow"],
        filled: { from: ["models.dev"], fields: ["maxTokens"], snapshot: {} },
      },
      { id: "mine", added: "hand", contextWindow: 32000, edited: ["contextWindow"] },
    ]);
  });

  it("keeps the favorites, which it never had", () => {
    const starred = {
      ...latest,
      favorites: [
        { service: "g", model: "mine" },
        { service: "g", model: "team-claude" },
      ],
    };
    const old = {
      version: 2,
      services: [
        {
          id: "g",
          kind: "openai-compatible",
          name: "网关",
          baseUrl: "https://gateway.example/v1",
          route: "direct",
          enabled: ["team-claude", "mine"],
          model: "team-claude",
        },
      ],
      default: { service: "g", model: "team-claude" },
    };
    const recovered = recoverOldWrite(starred, old);
    expect(recovered?.favorites).toEqual(starred.favorites);
    // The default it chose is the first favorite now.
    expect(recovered && favoritesOf(recovered)).toEqual([
      { service: "g", model: "team-claude" },
      { service: "g", model: "mine" },
    ]);
  });
});

describe("a page of 0.3.57 to 0.3.63 that makes its settings from the entries of an account", () => {
  it("takes away no model people added: it never knew of them", () => {
    const latest = settingsOf({
      version: 3,
      services: [
        {
          id: "g",
          kind: "openai-compatible",
          name: "gw",
          baseUrl: "https://gw.example/v1",
          route: "direct",
          enabled: ["mine", "svc"],
          models: [
            {
              id: "mine",
              added: "hand",
              contextWindow: 64000,
              maxTokens: 4000,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              edited: ["contextWindow", "maxTokens", "cost"],
            },
            { id: "svc", added: "service", contextWindow: 1000 },
          ],
        },
      ],
      default: { service: "g", model: "mine" },
    });
    const entries = entriesOfSettings(withAddresses(writeAiSettings(latest), latest))!;
    const old = settingsOfEntriesThen(entries) as Record<string, unknown>;
    expect(old.version).toBe(2);
    const models = recoverOldWrite(latest, old)?.services[0]?.models ?? [];
    expect(models.map((model) => model.id)).toEqual(["mine", "svc"]);
    expect(models[0]).toMatchObject({ maxTokens: 4000, cost: { input: 1, output: 2 } });
    // Where it did write the models of the service, one it left out is one it took away.
    const wrote = {
      ...old,
      services: (old.services as Record<string, unknown>[]).map((service) => ({
        ...service,
        models: [],
      })),
    };
    expect(recoverOldWrite(latest, wrote)?.services[0]?.models?.map((model) => model.id)).toEqual([
      "svc",
    ]);
  });
});

describe("summing up the earlier conversation by itself", () => {
  it("is on unless people turned it off, which is what is kept", async () => {
    expect(writeAiSettings(EMPTY_AI_SETTINGS).autoCompact).toBeUndefined();
    const off = writeAiSettings({ ...EMPTY_AI_SETTINGS, autoCompact: false });
    expect(off.autoCompact).toBe(false);
    expect(readAiSettings(off).settings.autoCompact).toBe(false);
    expect(readAiSettings({ ...off, autoCompact: true }).settings.autoCompact).toBeUndefined();
  });
});

describe("asking before a change of the project", () => {
  it("is off unless people turned it on, which is what is kept", () => {
    expect(writeAiSettings(EMPTY_AI_SETTINGS).askBeforeEdit).toBeUndefined();
    const on = writeAiSettings({ ...EMPTY_AI_SETTINGS, askBeforeEdit: true });
    expect(on.askBeforeEdit).toBe(true);
    expect(readAiSettings(on).settings.askBeforeEdit).toBe(true);
    expect(readAiSettings({ ...on, askBeforeEdit: "yes" }).settings.askBeforeEdit).toBeUndefined();
    expect(readAiSettings({ ...on, askBeforeEdit: false }).settings.askBeforeEdit).toBeUndefined();
  });
});

describe("favorite models", () => {
  const service = (enabled: string[]) => ({
    id: "a",
    kind: "anthropic",
    name: "Anthropic",
    route: "direct",
    enabled,
  });
  const ref = (model: string) => ({ service: "a", model });
  const saved = (more: object) => ({
    version: 4,
    services: [service(["opus", "sonnet", "haiku"])],
    ...more,
  });

  it("are kept in people's order, each once, and read back as written", () => {
    const settings = settingsOf(
      saved({
        default: ref("sonnet"),
        favorites: [ref("sonnet"), ref("opus"), ref("sonnet"), { service: "a" }, "x"],
      }),
    );
    expect(settings.favorites).toEqual([ref("sonnet"), ref("opus"), ref("sonnet")]);
    expect(favoritesOf(settings)).toEqual([ref("sonnet"), ref("opus")]);
    expect(roundTrip(settings)).toEqual(settings);
    expect(writeAiSettings(settings).favorites).toEqual(settings.favorites);
  });

  it("put the default first where a page of before, which knows only it, chose another one", () => {
    // Such a page keeps the favorites as a field it does not know, and changes the default.
    const settings = settingsOf(
      saved({ default: ref("haiku"), favorites: [ref("sonnet"), ref("opus")] }),
    );
    expect(favoritesOf(settings)).toEqual([ref("haiku"), ref("sonnet"), ref("opus")]);
  });

  it("are none without any: the default alone is not one", () => {
    const settings = settingsOf(saved({ default: ref("opus") }));
    expect(settings.favorites).toBeUndefined();
    expect(favoritesOf(settings)).toEqual([]);
    expect(writeAiSettings(settings)).not.toHaveProperty("favorites");
  });

  it("give the default where the one wanted is off: the first favorite that is on", () => {
    expect(
      settledDefault([service(["haiku", "opus"])], ref("sonnet"), [ref("sonnet"), ref("opus")]),
    ).toEqual(ref("opus"));
    expect(settledDefault([service(["haiku"])], ref("sonnet"), [ref("sonnet")])).toEqual(
      ref("haiku"),
    );
    // The first favorite turned off: the next one is the default, and stays first that is on.
    const settings = settingsOf({
      version: 4,
      services: [service(["opus", "haiku"])],
      default: ref("sonnet"),
      favorites: [ref("sonnet"), ref("opus")],
    });
    expect(settings.default).toEqual(ref("opus"));
    expect(favoritesOf(settings)).toEqual([ref("sonnet"), ref("opus")]);
  });

  it("go through a page of before (0.3.135 and older) as a field it keeps, and come back", () => {
    const now = settingsOf(
      saved({ default: ref("opus"), favorites: [ref("opus"), ref("sonnet")] }),
    );
    // Such a page reads them as a field it does not know, writes them back as they were, and
    // makes another model the default with its star.
    const written = writeAiSettings(now);
    const old = { ...written, default: ref("haiku") };
    const back = settingsOf(old);
    expect(back.favorites).toEqual([ref("opus"), ref("sonnet")]);
    expect(favoritesOf(back)).toEqual([ref("haiku"), ref("opus"), ref("sonnet")]);
    expect(back.default).toEqual(ref("haiku"));
  });

  it("go with the account as one field", () => {
    const entries = entriesOfSettings(
      writeAiSettings(settingsOf(saved({ default: ref("opus"), favorites: [ref("opus")] }))),
    );
    expect(entries?.get("field:favorites")).toEqual([ref("opus")]);
  });
});
