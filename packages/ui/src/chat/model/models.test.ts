import { describe, expect, it } from "vitest";
import { findModels, nextEffort, shortName, type Group } from "./models.ts";

describe("the model tag where the chat is narrow", () => {
  it("says the name from its last word that says something", () => {
    expect(shortName("GPT-6.1 Sol")).toBe("Sol");
    expect(shortName("Claude Opus 5.5")).toBe("Opus 5.5");
    expect(shortName("DeepSeek V4")).toBe("DeepSeek V4");
    expect(shortName("claude-other")).toBe("other");
    expect(shortName("claude-sonnet-4-5")).toBe("sonnet-4-5");
    expect(shortName("gemini")).toBe("gemini");
    expect(shortName("averyverylongmodelname")).toBe("averyverylongm…");
  });

  it("takes a word more while another model would read the same", () => {
    const names = ["a-sonnet-4-5", "b-sonnet-4-5", "a-opus-4-5"];
    expect(shortName("a-sonnet-4-5", names)).toBe("a-sonnet-4-5");
    expect(shortName("b-sonnet-4-5", names)).toBe("b-sonnet-4-5");
    expect(shortName("a-opus-4-5", names)).toBe("opus-4-5");
    expect(shortName("GPT-6.1 Sol", ["GPT-6.1 Sol", "Gemini Sol"])).toBe("GPT-6.1 Sol");
    // The same name twice is no rival of itself.
    expect(shortName("Claude Opus 5.5", ["Claude Opus 5.5"])).toBe("Opus 5.5");
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
