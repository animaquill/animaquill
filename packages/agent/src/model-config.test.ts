import { describe, expect, it } from "vitest";
import type { ModelConfig } from "./ai-settings.ts";
import {
  catalogValues,
  editField,
  effectiveValues,
  fillModel,
  levelEntry,
  levelSupported,
  levelText,
  liveOf,
  markOf,
  revertField,
  undoFill,
  type CatalogSay,
} from "./model-config.ts";

/** What the catalogs say of a model people add, cell by cell, and what people do to it. */

const say: CatalogSay = {
  service: { id: "qwen3-max", contextWindow: 256_000, reasoning: true },
  pi: undefined,
  modelsDev: {
    preset: {
      name: "Qwen3 Max",
      reasoning: false,
      image: false,
      contextWindow: 262_144,
      maxTokens: 32_768,
      efforts: ["low", "high"],
      cost: { input: 1.2, output: 6, cacheRead: 0.24, cacheWrite: 0 },
    },
    by: "provider",
    matched: "Alibaba",
  },
};

describe("filling a model in from the catalogs", () => {
  it("takes each cell from the most trusted catalog that has it: the service, pi, models.dev", () => {
    const values = catalogValues(say);
    expect(values.values.get("contextWindow")).toBe(256_000);
    expect(values.from.get("contextWindow")).toBe("service");
    expect(values.values.get("reasoning")).toBe(true);
    expect(values.values.get("name")).toBe("Qwen3 Max");
    expect(values.from.get("name")).toBe("models.dev");
    expect(values.values.get("maxTokens")).toBe(32_768);
    expect(values.values.get("cost")).toEqual({
      input: 1.2,
      output: 6,
      cacheRead: 0.24,
      cacheWrite: 0,
    });
    // The steps of models.dev's efforts, each as a cell of its own, all of models.dev.
    expect(values.values.get("thinking.medium")).toBeNull();
    expect(values.values.get("thinking.low")).toBeUndefined();
    expect(values.values.has("thinking.low")).toBe(true);
    expect(values.from.get("thinking.low")).toBe("models.dev");
  });

  it("never takes a price a service says of itself", () => {
    const values = catalogValues({
      service: { id: "m", cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } },
    });
    expect(values.values.has("cost")).toBe(false);
  });

  it("fills only empty cells, keeps what they were, and undoes it", () => {
    const before: ModelConfig = { id: "qwen3-max", added: "service", maxTokens: 8000 };
    const filled = fillModel(before, catalogValues(say));
    expect(filled.maxTokens).toBe(8000);
    expect(filled.contextWindow).toBe(256_000);
    expect(filled.name).toBe("Qwen3 Max");
    expect(filled.cost?.input).toBe(1.2);
    expect(filled.thinkingLevelMap).toEqual({
      minimal: null,
      medium: null,
      xhigh: null,
      max: null,
    });
    expect(filled.filled).toMatchObject({
      from: ["service", "models.dev"],
      by: "provider",
      matched: "Alibaba",
      snapshot: {},
    });
    expect(filled.filled?.fields).not.toContain("maxTokens");
    expect(undoFill(filled)).toEqual(before);
  });

  it("fills again what a catalog filled, never what people changed; undo goes back to before that", () => {
    const first = fillModel({ id: "qwen3-max" }, catalogValues(say));
    const changed = editField(first, "contextWindow", 100_000);
    expect(markOf(changed, "contextWindow", undefined)).toBe("edited");
    expect(markOf(changed, "maxTokens", undefined)).toBe("catalog");
    const later = catalogValues({
      ...say,
      service: { id: "qwen3-max", contextWindow: 300_000, maxTokens: 40_000 },
    });
    const again = fillModel(changed, later, true);
    expect(again.contextWindow).toBe(100_000);
    expect(again.maxTokens).toBe(40_000);
    expect(again.filled?.snapshot).toMatchObject({ maxTokens: 32_768 });
    const undone = undoFill(again);
    expect(undone.maxTokens).toBe(32_768);
    expect(undone.contextWindow).toBe(100_000);
    expect(undone.filled).toBeUndefined();
    // Filling only what is empty leaves what a catalog filled before.
    expect(fillModel(changed, later).maxTokens).toBe(32_768);
  });

  it("puts a cell people changed back to the catalog's, as the catalog's", () => {
    const changed = editField({ id: "qwen3-max" }, "name", "我的千问");
    expect(changed.edited).toEqual(["name"]);
    const back = revertField(changed, "name", catalogValues(say));
    expect(back.name).toBe("Qwen3 Max");
    expect(back.edited).toBeUndefined();
    expect(markOf(back, "name", undefined)).toBe("catalog");
    // Nothing in the catalogs: the cell is empty again.
    const none = revertField(
      editField({ id: "x" }, "maxTokens", 5),
      "maxTokens",
      catalogValues({}),
    );
    expect(none).toEqual({ id: "x" });
  });

  it("marks what pi knows of a model of its catalog as the catalog's, without a record", () => {
    const live = liveOf({ id: "claude", contextWindow: 1_000_000, reasoning: true });
    expect(markOf(undefined, "contextWindow", live)).toBe("catalog");
    expect(markOf(undefined, "maxTokens", live)).toBeUndefined();
    expect(effectiveValues({ id: "claude", maxTokens: 1 }, live)).toEqual({
      contextWindow: 1_000_000,
      reasoning: true,
      maxTokens: 1,
    });
  });
});

describe("the map of the steps of reasoning, as people tick and fill it", () => {
  it("is pi's map: not ticked is null, ticked and empty is not there, a value is sent as it is", () => {
    expect(levelEntry("low", false, "")).toBeNull();
    expect(levelEntry("low", true, "")).toBeUndefined();
    expect(levelEntry("low", true, " lo ")).toBe("lo");
    // pi offers "xhigh" and "max" only where the map has them: ticked and empty is its own name.
    expect(levelEntry("xhigh", true, "")).toBe("xhigh");
    expect(levelEntry("max", true, "")).toBe("max");
    expect(levelSupported(undefined, "high")).toBe(true);
    expect(levelSupported(undefined, "max")).toBe(false);
    expect(levelSupported({ max: "max" }, "max")).toBe(true);
    expect(levelSupported({ low: null }, "low")).toBe(false);
    expect(levelText({ max: "max", high: "h" }, "max")).toBe("");
    expect(levelText({ max: "max", high: "h" }, "high")).toBe("h");
  });

  it("keeps the other steps as they were when one is changed, as the map is sent whole", () => {
    const piMap = { xhigh: "xhigh", max: null };
    const changed = editField({ id: "m" }, "thinking.low", null, piMap);
    expect(changed.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: null, low: null });
    expect(changed.edited).toEqual(["thinking.low"]);
    const second = editField(changed, "thinking.high", "hi", piMap);
    expect(second.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: null, low: null, high: "hi" });
  });
});
