import type zhCN from "../i18n/zh-CN.json";
import type { TimelineEditor } from "../timeline/editor.ts";
import type { Action, ActionRegistry } from "../workbench/actions.ts";
import type { KeyframeEditor } from "./editor.ts";

export type KeyframeAction = keyof typeof zhCN.keyframes.action;

/** Keys that mean the same as on the timeline, for what can be done with keys. */
export function registerKeyframeActions(
  actions: ActionRegistry,
  keyframes: KeyframeEditor,
  timeline: TimelineEditor,
): void {
  const hasTimeline = () => timeline.model !== undefined;
  const hasKeys = () => keyframes.selection.size > 0;

  const add = (
    id: KeyframeAction,
    run: () => void,
    extra: Pick<Action, "keys" | "repeats" | "enabled"> = {},
  ) =>
    actions.register({
      id: `keyframes.${id}`,
      // The list of shortcuts has no context.
      title: (t) => t("keyframes.command", { action: t(`keyframes.action.${id}`) }),
      run,
      scope: "keyframes",
      enabled: hasTimeline,
      // These are about what is selected in the tab, and the palette is where people go elsewhere.
      palette: false,
      ...extra,
    });

  // What cannot change says why, rather than doing nothing.
  add("delete", () => keyframes.deleteSelected(), {
    keys: ["delete", "backspace"],
    enabled: hasKeys,
  });
  add("selectAll", () => keyframes.panel.selectAll(), { keys: ["mod+a"] });
  add("copy", () => keyframes.copySelected(), { keys: ["mod+c"], enabled: hasKeys });
  add("cut", () => keyframes.cutSelected(), { keys: ["mod+x"], enabled: hasKeys });
  add("paste", () => keyframes.paste(), {
    keys: ["mod+v"],
    enabled: () => keyframes.getSnapshot().hasClipboard,
  });
  add("toggleSnapping", () => timeline.toggleSnapping(), { keys: ["s"] });
  add("zoomIn", () => keyframes.panel.zoomIn(), { keys: ["="], repeats: true });
  add("zoomOut", () => keyframes.panel.zoomOut(), { keys: ["-"], repeats: true });
  add("zoomToFit", () => keyframes.panel.zoomToFit(), { keys: ["\\"] });
  add("rowsTaller", () => keyframes.panel.rowsTaller(), { keys: ["shift+="], repeats: true });
  add("rowsShorter", () => keyframes.panel.rowsShorter(), { keys: ["shift+-"], repeats: true });

  // Selected keys move by frames. Without any, the playhead does, as on the timeline.
  const step = (frames: number) => () => {
    if (keyframes.hasMovableSelection) keyframes.nudge(frames);
    else timeline.stepFrames(frames);
  };
  add("previousFrame", step(-1), { keys: ["left"], repeats: true });
  add("nextFrame", step(1), { keys: ["right"], repeats: true });
  add("backFiveFrames", step(-5), { keys: ["shift+left"], repeats: true });
  add("forwardFiveFrames", step(5), { keys: ["shift+right"], repeats: true });
}
