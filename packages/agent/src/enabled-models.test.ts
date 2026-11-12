import { describe, expect, it } from "vitest";
import { bulkActions, filterModels, isLastEnabled } from "./enabled-models.ts";

const rows = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", enabled: true },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", enabled: false },
  { id: "deepseek-flash", enabled: true },
];

describe("models that are on", () => {
  it("are filtered by name and id", () => {
    expect(filterModels(rows, "SONNET").map(({ id }) => id)).toEqual(["claude-sonnet-5-5"]);
    expect(filterModels(rows, "flash").map(({ id }) => id)).toEqual(["deepseek-flash"]);
    expect(filterModels(rows, " ")).toHaveLength(3);
  });

  it("always keep at least one on", () => {
    expect(isLastEnabled(1, rows[0] as (typeof rows)[number])).toBe(true);
    expect(isLastEnabled(2, rows[0] as (typeof rows)[number])).toBe(false);
    expect(isLastEnabled(1, rows[1] as (typeof rows)[number])).toBe(false);
    // All off for these two would leave the one of another service: allowed.
    expect(bulkActions(3, rows.slice(0, 2))).toEqual({
      enable: ["claude-sonnet-5-5"],
      disable: ["claude-opus-5-5"],
      canEnable: true,
      canDisable: true,
    });
    // Nothing else is on: not allowed.
    expect(bulkActions(2, rows).canDisable).toBe(false);
    expect(bulkActions(0, []).canEnable).toBe(false);
  });
});
