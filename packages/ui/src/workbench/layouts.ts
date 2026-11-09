import type { LayoutNode, LayoutPreset, LayoutTabs, TabStrip } from "./layout.ts";

type Child = readonly [share: number, node: LayoutNode];

const row = (...children: Child[]): LayoutNode => ({ kind: "split", direction: "row", children });
const column = (...children: Child[]): LayoutNode => ({
  kind: "split",
  direction: "column",
  children,
});
const tabs =
  (strip: TabStrip, pinned = true) =>
  (...panels: string[]): LayoutTabs => ({ kind: "tabs", panels, strip, pinned });
const top = tabs("top");
const left = tabs("left");
const right = tabs("right");

/**
 * The layouts that come with the editor, as designed in docs/design/workbench.md, sections 2 and 3.
 * They also name panels that are not there yet: the explorer, transitions and effects, which have
 * no panel yet, and chat, history, notes, music, recording, versions and the terminal, which are
 * placeholders. Each shows up in its place once it is ready, see `LayoutController`.
 */
export const layouts: readonly LayoutPreset[] = [
  {
    id: "edit",
    title: (t) => t("layout.edit"),
    layout: column(
      [
        60,
        row(
          // Editing starts from the assets.
          [
            22,
            { ...left("files", "explorer", "assets", "transitions", "effects"), active: "assets" },
          ],
          [52, top("preview", "code", "music", "recording", "versions")],
          [26, right("properties", "chat", "history", "notes")],
        ),
      ],
      [40, left("timeline", "keyframes", "problems", "terminal")],
    ),
  },
  {
    id: "animate",
    title: (t) => t("layout.animate"),
    // The preview and the code side by side, to see a change while making it.
    layout: column(
      [
        50,
        row(
          [21, left("explorer", "assets", "transitions", "effects", "files")],
          [28, top("preview")],
          [28, top("code")],
          [23, right("properties", "chat", "history")],
        ),
      ],
      [50, left("keyframes", "timeline", "problems")],
    ),
  },
  {
    id: "audio",
    title: (t) => t("layout.audio"),
    layout: column(
      [
        55,
        row(
          [22, left("assets", "explorer", "effects")],
          [52, top("music", "recording", "preview")],
          [26, right("properties", "history")],
        ),
      ],
      [45, left("timeline", "problems")],
    ),
  },
  {
    id: "ai",
    title: (t) => t("layout.ai"),
    // What has to do with AI is on the right, all the way down, and only as wide as its icons.
    layout: row(
      [
        76,
        column(
          [
            60,
            row(
              [28, left("explorer", "assets", "transitions", "effects", "files")],
              [72, top("preview", "code")],
            ),
          ],
          [40, left("timeline", "keyframes", "problems")],
        ),
      ],
      [24, tabs("right", false)("chat", "history", "notes", "properties")],
    ),
  },
];
