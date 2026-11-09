import { describe, expect, it } from "vitest";
import { toDockviewState } from "../dock/toDockview.ts";
import { builtinPanels } from "../panels/builtin.tsx";
import { isBindable } from "./keys.ts";
import { panelsOf, pruneLayout, type LayoutNode, type LayoutTabs } from "./layout.ts";
import { layouts } from "./layouts.ts";

/** Designed in docs/design/resource-panels.md, with no panel yet. */
const STILL_TO_COME = ["explorer", "effects"];

const ready = new Set(builtinPanels.filter((panel) => !panel.planned).map((panel) => panel.type));
const facts = { title: (type: string) => type, keepAlive: () => false };

function groupsOf(node: LayoutNode): LayoutTabs[] {
  if (node.kind === "tabs") return [node];
  return node.children.flatMap(([, child]) => groupsOf(child));
}

describe.each(layouts.map((layout) => [layout.id, layout] as const))("layout %s", (_, layout) => {
  const panels = panelsOf(layout.layout);
  const shown = pruneLayout(layout.layout, (type) => ready.has(type));

  it("uses only panels that exist or are still to come", () => {
    const known = new Set([...builtinPanels.map((panel) => panel.type), ...STILL_TO_COME]);
    expect(panels.filter((panel) => !known.has(panel))).toEqual([]);
  });

  it("has each panel once", () => {
    expect(new Set(panels).size).toBe(panels.length);
  });

  it("shows the preview and the timeline with the panels there are now", () => {
    expect(shown && panelsOf(shown)).toEqual(expect.arrayContaining(["preview", "timeline"]));
  });

  it("keeps every group of the design with the panels there are now", () => {
    expect(shown && groupsOf(shown)).toHaveLength(groupsOf(layout.layout).length);
  });

  it("can be built", () => {
    expect(() => shown && toDockviewState(shown, 1440, 843, facts)).not.toThrow();
  });
});

it("keeps what has to do with AI on the right, all the way down, as icons", () => {
  const ai = layouts.find((layout) => layout.id === "ai")?.layout;
  if (ai?.kind !== "split") throw new Error("No AI layout");
  expect(ai.direction).toBe("row");
  const right = ai.children.at(-1)?.[1];
  expect(right).toMatchObject({ kind: "tabs", strip: "right", pinned: false });
  expect(right?.kind === "tabs" && right.panels).toEqual(
    expect.arrayContaining(["chat", "history", "notes"]),
  );
});

it("shows only the icons of tabs down a side, everywhere", () => {
  const pinned = layouts.flatMap((layout) =>
    groupsOf(layout.layout).filter((group) => group.pinned === true),
  );
  expect(pinned).toEqual([]);
});

describe("default keys", () => {
  const defaults = [
    ...builtinPanels.flatMap((panel) => panel.keys ?? []),
    "mod+shift+p",
    "f1",
    ...Array.from({ length: 9 }, (_, index) => `alt+shift+${index + 1}`),
  ];

  it("are each used once", () => {
    expect(new Set(defaults).size).toBe(defaults.length);
  });

  it("can all be bound", () => {
    expect(defaults.filter((combo) => !isBindable(combo))).toEqual([]);
  });
});
