import { describe, expect, it } from "vitest";
import { withoutKeys } from "./secrets.ts";
import {
  SERVICE_GROUPS,
  SERVICE_KINDS,
  checkBaseUrl,
  failureOf,
  kindOf,
  listModels,
  recommendedOf,
} from "./services.ts";

const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

describe("keys", () => {
  it("never show in what services say", () => {
    const said = `401 invalid x-api-key ${KEY}; key ends in ${KEY.slice(-8)}, starts ${KEY.slice(0, 12)}`;
    const clean = withoutKeys(said, [KEY]);
    expect(clean).not.toContain(KEY.slice(-8));
    expect(clean).not.toContain(KEY.slice(0, 12));
    expect(clean).toContain("401 invalid x-api-key");
  });

  it("go also when only their shape is known", () => {
    expect(withoutKeys("Incorrect API key provided: sk-proj-****abcd1234")).not.toContain("abcd");
    expect(withoutKeys("key AIzaSyA1234567890abcdefg is bad")).not.toContain("AIza");
    expect(withoutKeys("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghij");
  });
});

describe("failures", () => {
  it("are told apart by what calls for different advice", () => {
    expect(failureOf("TypeError: Failed to fetch").kind).toBe("network");
    expect(failureOf("Connection error.").kind).toBe("network");
    expect(failureOf('401 {"error":{"type":"authentication_error"}}').kind).toBe("key");
    expect(failureOf("429 rate_limit_error").kind).toBe("rate");
    expect(failureOf("404 model not found").kind).toBe("notFound");
    expect(failureOf("529 overloaded").kind).toBe("server");
    expect(failureOf("something else").kind).toBe("other");
    expect(failureOf(`401 ${KEY}`, [KEY]).message).not.toContain(KEY);
  });
});

describe("services", () => {
  it("each kind has a protocol and, unless people give one, an https address", () => {
    const ids = new Set(SERVICE_KINDS.map((kind) => kind.id));
    expect(ids.size).toBe(SERVICE_KINDS.length);
    for (const kind of SERVICE_KINDS) {
      if (kind.custom) expect(kind.baseUrl).toBe("");
      else expect(kind.baseUrl).toMatch(/^https:\/\/[^/]+/);
    }
  });

  it("take addresses of https, and of http for servers of one's own", () => {
    expect(checkBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(checkBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(checkBaseUrl("ftp://x")).toBeUndefined();
    expect(checkBaseUrl("https://user:pass@x.com")).toBeUndefined();
    expect(checkBaseUrl("not a url")).toBeUndefined();
  });

  it("each kind is in one of the groups that adding a service shows", () => {
    for (const kind of SERVICE_KINDS) expect(SERVICE_GROUPS).toContain(kind.group);
    expect(SERVICE_KINDS.filter((kind) => kind.group === "own").every((kind) => kind.custom)).toBe(
      true,
    );
    // Only kinds whose models pi knows recommend some.
    for (const kind of SERVICE_KINDS) if (kind.recommended) expect(kind.catalog).toBeDefined();
  });

  it("start new services with the recommended models they have, else the first three", () => {
    const anthropic = kindOf("anthropic");
    const dashscope = kindOf("dashscope");
    if (!anthropic || !dashscope) throw new Error("kinds missing");
    const models = ["claude-haiku-5-5", "claude-opus-5-5", "claude-x"].map((id) => ({ id }));
    expect(recommendedOf(anthropic, models)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
    const listed = ["qwen-a", "qwen-b", "qwen-c", "qwen-d"].map((id) => ({ id }));
    expect(recommendedOf(dashscope, listed)).toEqual(["qwen-a", "qwen-b", "qwen-c"]);
    expect(recommendedOf(dashscope, [])).toEqual([]);
  });

  it("list their models, and say why when they cannot", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const answering = (status: number, body: unknown): typeof fetch =>
      (async (url: string, init: RequestInit) => {
        seen.push({ url, headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const listed = await listModels("openai-completions", "https://api.x/v1", "k-123456789", {
      fetch: answering(200, { data: [{ id: "b" }, { id: "a" }] }),
    });
    expect(listed).toEqual({ ok: true, models: [{ id: "a" }, { id: "b" }] });
    expect(seen[0]).toMatchObject({
      url: "https://api.x/v1/models",
      headers: { authorization: "Bearer k-123456789" },
    });

    const google = await listModels("google-generative-ai", "https://g/v1beta", "AIzaKEY", {
      fetch: answering(200, {
        models: [
          {
            name: "models/gemini-x",
            displayName: "Gemini X",
            supportedGenerationMethods: ["generateContent"],
          },
          { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
        ],
      }),
    });
    expect(google).toEqual({ ok: true, models: [{ id: "gemini-x", name: "Gemini X" }] });

    const refused = await listModels("anthropic-messages", "https://a", KEY, {
      fetch: answering(401, { error: { message: `invalid x-api-key ${KEY}` } }),
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.failure.kind).toBe("key");
      expect(refused.failure.message).not.toContain(KEY);
    }

    const blocked = await listModels("anthropic-messages", "https://a", KEY, {
      fetch: (async () => {
        throw new TypeError("Failed to fetch");
      }) as typeof fetch,
    });
    expect(!blocked.ok && blocked.failure.kind).toBe("network");
  });
});
