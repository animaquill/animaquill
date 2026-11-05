import { describe, expect, it } from "vitest";
import { builtinPanels } from "../panels/builtin.tsx";
import type { LayoutNode } from "./layout.ts";
import { workspaces } from "./workspaces.ts";

function panelsOf(node: LayoutNode): string[] {
  if (node.kind === "tabs") return [...node.panels];
  return node.children.flatMap(([, child]) => panelsOf(child));
}

describe.each(workspaces.map((workspace) => [workspace.id, workspace] as const))(
  "workspace %s",
  (_, workspace) => {
    const panels = panelsOf(workspace.layout);

    it("uses only panels that exist", () => {
      const known = new Set(builtinPanels.map((panel) => panel.type));
      expect(panels.filter((panel) => !known.has(panel))).toEqual([]);
    });

    it("has each panel once", () => {
      expect(new Set(panels).size).toBe(panels.length);
    });

    it("shows the preview and the timeline", () => {
      expect(panels).toEqual(expect.arrayContaining(["preview", "timeline"]));
    });
  },
);
