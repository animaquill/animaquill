import { ProjectStore } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { describe, expect, test } from "vitest";
import {
  foldRows,
  placeRows,
  placeSummary,
  quickChoice,
  sortRows,
  totalOf,
  type PlaceRow,
} from "./place-choice.ts";
import type { UploadItem } from "./uploads.ts";

/**
 * The dialog "素材放在哪" as rows (place-choice.ts): what can be chosen and what cannot, the quick
 * choices, the order, the small files folded away, and what a choice comes to.
 */

const MB = 1024 * 1024;
const hash = (n: number) => `sha256-${String(n).padStart(43, "A")}`;

function project() {
  const store = ProjectStore.create(createProject({ name: "片子" }));
  const add = (id: string, kind: string, size: number, n: number) =>
    store.execute({
      type: "asset.add",
      params: {
        id,
        asset: {
          kind,
          storage: "local",
          path: `assets/${id}`,
          name: `${id}.x`,
          hash: hash(n),
          size,
        },
      },
    });
  add("big", "video", 300 * MB, 1);
  add("huge", "video", 3 * 1024 * MB, 2);
  add("sound", "audio", 2 * MB, 3);
  add("away", "video", 10 * MB, 4);
  add("going", "image", 1 * MB, 5);
  return store;
}

const row = (asset: string, rows: readonly PlaceRow[]) => rows.find((each) => each.asset === asset);

describe("which assets go where", () => {
  test("says of each where it is, and only what is here can be chosen", () => {
    const store = project();
    const going: UploadItem = {
      asset: "going",
      name: "going.x",
      size: MB,
      hash: hash(5),
      phase: "sending",
      received: 0,
      at: 1,
    };
    const rows = placeRows(store.getState(), [going], new Set(["away"]));
    expect(rows.map(({ asset, where }) => [asset, where])).toEqual([
      ["big", "here"],
      ["huge", "tooLarge"],
      ["sound", "here"],
      ["away", "noFile"],
      ["going", "on"],
    ]);
    expect(rows.every((each) => each.uses === 0)).toBe(true);
    // Nothing that cannot be chosen is chosen, whatever the quick choice.
    expect([...quickChoice(rows, "all")]).toEqual(["big", "sound"]);
    expect([...quickChoice(rows, "used")]).toEqual([]);
    expect([...quickChoice(rows, "large")]).toEqual(["big"]);
    expect([...quickChoice(rows, "videos")]).toEqual(["big"]);
    expect(totalOf(rows, new Set(["big", "huge", "sound"]))).toEqual({
      count: 2,
      bytes: 302 * MB,
    });
    expect(placeSummary(rows)).toEqual({ there: 0, thereBytes: 0, here: 4 });
    expect(sortRows(rows, "size").map(({ asset }) => asset)).toEqual([
      "huge",
      "big",
      "away",
      "sound",
      "going",
    ]);
    expect(row("big", sortRows(rows, "name"))).toBeDefined();
  });

  test("folds small files away where there are many", () => {
    const many = Array.from({ length: 12 }, (_, index): PlaceRow => ({
      asset: `a${index}`,
      name: `a${index}`,
      kind: "image",
      size: index < 3 ? 10 * MB : MB,
      uses: 0,
      where: "here",
    }));
    const { shown, folded } = foldRows(many);
    expect(shown).toHaveLength(3);
    expect(folded).toHaveLength(9);
    expect(foldRows(many.slice(0, 5)).folded).toEqual([]);
  });
});
