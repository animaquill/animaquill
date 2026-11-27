import { describe, expect, it } from "vitest";
import { findModels, nextEffort, shortName, type Group } from "./models.ts";

describe("the model tag where the chat is narrow", () => {
  it("says the last word of the name, unless it says too little", () => {
    expect(shortName("GPT-6.1 Sol")).toBe("Sol");
    expect(shortName("Claude Opus 5.5")).toBe("Opus 5.5");
    expect(shortName("a-very-long-modelname")).toBe("modelname");
    expect(shortName("averyverylongmodelname")).toBe("averyverylon…");
    expect(shortName("DeepSeek V4")).toBe("DeepSeek V4");
    expect(shortName("claude-other")).toBe("other");
    expect(shortName("gemini")).toBe("gemini");
  });
});

describe("Alt+R", () => {
  it("goes up through the steps the model takes, then back to 自动", () => {
    const levels = ["low", "medium", "high"] as const;
    expect(nextEffort(levels, undefined)).toBe("low");
    expect(nextEffort(levels, "medium")).toBe("high");
    expect(nextEffort(levels, "high")).toBeUndefined();
    // A step this model does not take, chosen with another: back to 自动.
    expect(nextEffort(levels, "max")).toBeUndefined();
  });
});

describe("the search of the bubble", () => {
  const group = (service: string, name: string, ids: string[]): Group => ({
    service,
    name,
    dim: undefined,
    rows: ids.map((id) => ({ service, model: { id, enabled: true } as never })),
  });
  it("finds by name, id or service, any case, and leaves out what has nothing", () => {
    const groups = [group("a", "Anthropic", ["claude-opus"]), group("o", "OpenAI", ["gpt-6"])];
    expect(findModels(groups, "  ").length).toBe(2);
    expect(findModels(groups, "OPUS").map((each) => each.service)).toEqual(["a"]);
    expect(findModels(groups, "openai").map((each) => each.rows.length)).toEqual([1]);
    expect(findModels(groups, "nothing")).toEqual([]);
  });
});
