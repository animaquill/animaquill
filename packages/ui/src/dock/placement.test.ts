import { describe, expect, it } from "vitest";
import { builtinPanels } from "../panels/builtin.tsx";
import { sizesOf, type PanelArea, type PanelDefinition } from "../workbench/panels.ts";
import { placePanel, type PlacementGroup } from "./placement.ts";

const known = new Map(builtinPanels.map((panel) => [panel.type, panel]));
const sizes = (type: string) => {
  const panel = known.get(type);
  return panel ? sizesOf(panel) : [];
};

const panel = (type: string) => {
  const definition = known.get(type);
  if (!definition) throw new Error(type);
  return { type, sizes: sizesOf(definition), area: definition.area, beside: definition.beside };
};

/** Groups in the order given, all the same size and never used unless the test says otherwise. */
function groups(
  ...list: [id: string, panels: string[], more?: Partial<PlacementGroup>][]
): PlacementGroup[] {
  return list.map(([id, panels, more], order) => ({
    id,
    panels,
    used: undefined,
    width: 300,
    height: 300,
    order,
    ...more,
  }));
}

/** The default layout of the table: preview, files and assets, timeline and keyframes, properties and chat. */
const defaults = (used: Record<string, number> = {}) =>
  groups(
    ["G1", ["preview"], { used: used["G1"] }],
    ["G2", ["files", "assets"], { used: used["G2"] }],
    ["G3", ["timeline", "keyframes"], { used: used["G3"] }],
    ["G4", ["properties", "chat"], { used: used["G4"] }],
  );

const place = (type: string, layout: PlacementGroup[]) => placePanel(panel(type), layout, sizes);

describe("placing a panel (settings-and-properties 11.5)", () => {
  it("1: effects go to the only large group", () => {
    expect(place("effects", defaults())).toEqual({ kind: "into", group: "G1" });
  });

  it("2: explorer goes to the tall group used last, the chat's", () => {
    expect(place("explorer", defaults({ G4: 20, G2: 10 }))).toEqual({ kind: "into", group: "G4" });
  });

  it("3: explorer goes to the tall group used last, the assets'", () => {
    expect(place("explorer", defaults({ G2: 20, G4: 10 }))).toEqual({ kind: "into", group: "G2" });
  });

  it("4: problems, wide and tall, go to a tall group before a wide one", () => {
    expect(place("problems", defaults({ G4: 5 }))).toEqual({ kind: "into", group: "G4" });
    expect(place("problems", defaults({ G2: 5 }))).toEqual({ kind: "into", group: "G2" });
    expect(place("problems", defaults({ G3: 50, G2: 5 }))).toEqual({ kind: "into", group: "G2" });
  });

  it("5: performance goes to the only wide group", () => {
    expect(place("performance", defaults())).toEqual({ kind: "into", group: "G3" });
  });

  it("6: without a large group, transitions go to the tall group used last", () => {
    const layout = (left: number, right: number) =>
      groups(
        ["G2", ["files"], { used: left }],
        ["G3", ["timeline"]],
        ["G4", ["properties"], { used: right }],
      );
    expect(place("transitions", layout(1, 2))).toEqual({ kind: "into", group: "G4" });
    expect(place("transitions", layout(2, 1))).toEqual({ kind: "into", group: "G2" });
  });

  it("7: without a wide group, the timeline opens a new group below", () => {
    const layout = groups(["G1", ["preview"]], ["G2", ["files"]], ["G4", ["properties"]]);
    expect(place("timeline", layout)).toEqual({ kind: "new", area: "bottom" });
  });

  it("8: assets go to the only large group, half of which is the chat", () => {
    const layout = groups(["G5", ["preview", "chat"]], ["G2", ["files"]]);
    expect(place("assets", layout)).toEqual({ kind: "into", group: "G5" });
  });

  it("9: history goes to the group that is all tall, before the one that is half", () => {
    const layout = groups(["G5", ["preview", "chat"], { used: 10 }], ["G4", ["properties"]]);
    expect(place("history", layout)).toEqual({ kind: "into", group: "G4" });
  });

  it("10: between two large groups, effects go to the one used last", () => {
    const layout = groups(["G6", ["assets"], { used: 1 }], ["G1", ["preview"], { used: 2 }]);
    expect(place("effects", layout)).toEqual({ kind: "into", group: "G1" });
  });

  it("11: between two large groups nobody used, effects go to the larger one", () => {
    const layout = groups(
      ["G6", ["assets"], { width: 280, height: 700 }],
      ["G1", ["preview"], { width: 900, height: 500 }],
    );
    expect(place("effects", layout)).toEqual({ kind: "into", group: "G1" });
  });

  it("12: code opens in a column of its own next to the preview", () => {
    const layout = groups(["G1", ["preview"]], ["G2", ["files"]]);
    expect(place("code", layout)).toEqual({ kind: "beside", group: "G1" });
  });

  it("13: without the preview and a large group, code opens a new group in the middle", () => {
    const layout = groups(["G2", ["files"]], ["G3", ["timeline"]]);
    expect(place("code", layout)).toEqual({ kind: "new", area: "center" });
  });

  it("14: the chat behind properties stays where it is, and is switched to", () => {
    expect(place("chat", defaults())).toEqual({ kind: "there", group: "G4" });
  });

  it("15: an empty group is of no kind", () => {
    expect(place("preview", groups(["G0", []]))).toEqual({ kind: "new", area: "center" });
  });

  it("16: a panel of the host without sizes counts as tall on the right", () => {
    const hosted: Pick<PanelDefinition, "area" | "sizes"> = { area: "right" as PanelArea };
    const placed = { type: "hosted", sizes: sizesOf(hosted), area: hosted.area };
    expect(placed.sizes).toEqual(["tall"]);
    const layout = groups(["G1", ["preview"]], ["G3", ["timeline"]], ["G4", ["properties"]]);
    expect(placePanel(placed, layout, sizes)).toEqual({ kind: "into", group: "G4" });
  });

  it("goes by shape only when nothing else decides, and by order after that", () => {
    const layout = groups(["A", ["files"], { height: 400 }], ["B", ["chat"], { height: 400 }]);
    expect(place("explorer", layout)).toEqual({ kind: "into", group: "A" });
  });
});

describe("sizes of the panels", () => {
  it("every panel that comes with the editor says what room it is made for", () => {
    for (const definition of builtinPanels) {
      expect(definition.sizes?.length, definition.type).toBeGreaterThan(0);
    }
    expect(builtinPanels.map((definition) => definition.type).toSorted()).toEqual(
      [
        "annotations",
        "assets",
        "cache",
        "chat",
        "code",
        "differences",
        "effects",
        "explorer",
        "exports",
        "files",
        "history",
        "keyframes",
        "music",
        "notes",
        "performance",
        "preview",
        "problems",
        "properties",
        "recording",
        "terminal",
        "timeline",
        "transitions",
        "versions",
      ].toSorted(),
    );
  });

  it("follow from the area when a panel says nothing", () => {
    expect(sizesOf({ area: "center" })).toEqual(["large"]);
    expect(sizesOf({ area: "left" })).toEqual(["tall"]);
    expect(sizesOf({ area: "bottom" })).toEqual(["wide"]);
    expect(sizesOf({ area: "bottom", sizes: [] })).toEqual(["wide"]);
  });
});
