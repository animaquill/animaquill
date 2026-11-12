import { describe, expect, it } from "vitest";
import { parseListedModels } from "./model-discovery.ts";

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
      levels: ["off", "low", "high"],
    });
  });

  it("takes Google's names and leaves out what cannot hold a conversation", () => {
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
    ).toEqual([{ id: "gemini-x", name: "Gemini X", contextWindow: 1048576 }]);
  });

  it("takes Anthropic's display names", () => {
    expect(
      parseListedModels({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }] }),
    ).toEqual([{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }]);
  });
});
