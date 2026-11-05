import type { LayoutNode, WorkspaceDefinition } from "./layout.ts";

type Child = readonly [share: number, node: LayoutNode];

const row = (...children: Child[]): LayoutNode => ({ kind: "split", direction: "row", children });
const column = (...children: Child[]): LayoutNode => ({
  kind: "split",
  direction: "column",
  children,
});
const tabs = (...panels: string[]): LayoutNode => ({ kind: "tabs", panels });

export const workspaces: readonly WorkspaceDefinition[] = [
  {
    id: "edit",
    title: (t) => t("workspace.edit"),
    layout: column(
      [
        58,
        row([20, tabs("assets", "files")], [58, tabs("preview")], [22, tabs("properties", "chat")]),
      ],
      [42, tabs("timeline", "problems", "terminal")],
    ),
  },
  {
    id: "animate",
    title: (t) => t("workspace.animate"),
    layout: column(
      [
        58,
        row([18, tabs("files", "assets")], [57, tabs("preview", "code")], [25, tabs("properties")]),
      ],
      [42, row([50, tabs("timeline")], [50, tabs("keyframes")])],
    ),
  },
  {
    id: "audio",
    title: (t) => t("workspace.audio"),
    layout: column(
      [
        50,
        row(
          [22, tabs("assets")],
          [48, tabs("music", "recording")],
          [30, tabs("preview", "properties")],
        ),
      ],
      [50, tabs("timeline")],
    ),
  },
  {
    id: "ai",
    title: (t) => t("workspace.ai"),
    layout: row(
      [30, tabs("chat", "annotations")],
      [
        70,
        column(
          [60, row([68, tabs("preview")], [32, tabs("properties")])],
          [40, tabs("timeline", "terminal", "problems")],
        ),
      ],
    ),
  },
];
