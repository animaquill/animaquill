import { describe, expect, it } from "vitest";
import { parseListedModels, supportedLevels } from "./model-discovery.ts";

describe("what services say of their models", () => {
  it("is read from the shapes they answer in", () => {
    expect(parseListedModels({ data: [{ id: "b" }, { id: "a" }, { id: "a" }] })).toEqual([
      { id: "a" },
      { id: "b" },
    ]);
    expect(parseListedModels(["x", " ", "y"])).toEqual([{ id: "x" }, { id: "y" }]);
    expect(parseListedModels({ models: { one: { model: "m1" } } })).toEqual([{ id: "m1" }]);
    expect(parseListedModels("nothing")).toEqual([]);
  });

  it("tells how much a model reads, whether it thinks and takes pictures, where it says", () => {
    const [model] = parseListedModels({
      data: [
        {
          id: "vendor/model",
          name: "Model",
          context_length: "131072",
          supports_reasoning: true,
          supported_efforts: ["low", "high", "turbo"],
          modalities: { input: ["text", "image"] },
          pricing: { prompt: "0.000001" },
        },
      ],
    });
    expect(model).toEqual({
      id: "vendor/model",
      name: "Model",
      contextWindow: 131072,
      reasoning: true,
      image: true,
      thinkingLevelMap: { minimal: null, medium: null, xhigh: null, max: null },
    });
  });

  it("takes Google's names and says what cannot hold a conversation", () => {
    expect(
      parseListedModels({
        models: [
          {
            name: "models/gemini-x",
            displayName: "Gemini X",
            inputTokenLimit: 1048576,
            supportedGenerationMethods: ["generateContent"],
          },
          { name: "models/embed", supportedGenerationMethods: ["embedContent"] },
        ],
      }),
    ).toEqual([
      { id: "embed", chat: false },
      { id: "gemini-x", name: "Gemini X", contextWindow: 1048576 },
    ]);
  });

  it("takes Anthropic's display names", () => {
    expect(
      parseListedModels({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }),
    ).toEqual([{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }]);
  });
});

describe("more of what services say of their models", () => {
  it("reads the most an answer writes, and what is not for a conversation", () => {
    const models = parseListedModels({
      data: [
        { id: "m", max_output_tokens: 32000, max_tokens: 999, supports_reasoning: true },
        { id: "text-embedding-3-small" },
        { id: "gpt-4o-mini-tts" },
        { id: "whisper-1" },
        { id: "omni-moderation-latest" },
        { id: "bge-m3" },
        { id: "img", architecture: { output_modalities: ["image"] } },
        { id: "rr", type: "rerank" },
        { id: "gpt-5", modalities: { input: ["text"], output: ["text"] } },
        "qwen-tts",
      ],
    });
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("m")).toEqual({ id: "m", maxTokens: 32000, reasoning: true });
    for (const id of [
      "text-embedding-3-small",
      "gpt-4o-mini-tts",
      "whisper-1",
      "omni-moderation-latest",
      "bge-m3",
      "img",
      "rr",
      "qwen-tts",
    ])
      expect(byId.get(id)?.chat, id).toBe(false);
    expect(byId.get("gpt-5")?.chat).toBeUndefined();
  });

  it("says which steps of reasoning a model takes, as pi works them out", () => {
    expect(supportedLevels(false, undefined)).toEqual(["off"]);
    expect(supportedLevels(true, undefined)).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(supportedLevels(true, { off: null, xhigh: "xhigh", max: "max" })).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});
