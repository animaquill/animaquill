import type zhCN from "../i18n/zh-CN.json";
import type { Action, ActionRegistry } from "../workbench/actions.ts";
import type { TimelineEditor } from "./editor.ts";

export type TimelineAction = keyof typeof zhCN.timeline.action;

/** Keys as people know them from Premiere. Everything can be changed in the list of shortcuts. */
export function registerTimelineActions(actions: ActionRegistry, editor: TimelineEditor): void {
  const hasTimeline = () => editor.model !== undefined;
  const hasSelection = () => editor.getSnapshot().selection.size > 0;

  const add = (
    id: TimelineAction,
    run: () => void,
    {
      group,
      ...extra
    }: Pick<Action, "keys" | "repeats" | "enabled" | "selected"> & {
      readonly group?: string;
    } = {},
  ) =>
    actions.register({
      id: `timeline.${id}`,
      // The palette and the list of shortcuts have no context, a menu called 时间轴 has.
      title: (t) => t("timeline.command", { action: t(`timeline.action.${id}`) }),
      run,
      scope: "timeline",
      enabled: hasTimeline,
      ...(group === undefined
        ? {}
        : { menu: { name: "timeline", group, title: (t) => t(`timeline.action.${id}`) } }),
      ...extra,
    });

  add("addColor", () => editor.addColorClip(), { group: "add" });
  add("addVideoTrack", () => editor.addTrack("video"), { group: "add" });
  add("addAudioTrack", () => editor.addTrack("audio"), { group: "add" });
  add("addCaptionTrack", () => editor.addTrack("caption"), { group: "add" });

  add("split", () => editor.splitAtPlayhead(), {
    keys: ["mod+k"],
    enabled: () => editor.canSplit,
    group: "edit",
  });
  add("delete", () => editor.deleteSelection(), {
    keys: ["delete", "backspace"],
    enabled: () => hasTimeline() && hasSelection(),
    group: "edit",
  });
  add("selectAll", () => editor.selectAll(), { keys: ["mod+a"], group: "edit" });

  add("toolSelect", () => editor.setTool("select"), {
    keys: ["v"],
    selected: () => editor.getSnapshot().tool === "select",
    group: "tools",
  });
  add("toolRazor", () => editor.setTool("razor"), {
    keys: ["c"],
    selected: () => editor.getSnapshot().tool === "razor",
    group: "tools",
  });
  add("toggleSnapping", () => editor.toggleSnapping(), { keys: ["s"], group: "tools" });

  add("zoomIn", () => editor.zoomIn(), { keys: ["="], repeats: true, group: "zoom" });
  add("zoomOut", () => editor.zoomOut(), { keys: ["-"], repeats: true, group: "zoom" });
  add("zoomToFit", () => editor.zoomToFit(), { keys: ["\\"], group: "zoom" });

  add("previousFrame", () => editor.stepFrames(-1), { keys: ["left"], repeats: true });
  add("nextFrame", () => editor.stepFrames(1), { keys: ["right"], repeats: true });
  add("backFiveFrames", () => editor.stepFrames(-5), { keys: ["shift+left"], repeats: true });
  add("forwardFiveFrames", () => editor.stepFrames(5), { keys: ["shift+right"], repeats: true });
  add("previousEdit", () => editor.jumpToEdit(-1), { keys: ["up"], repeats: true });
  add("nextEdit", () => editor.jumpToEdit(1), { keys: ["down"], repeats: true });
  add("start", () => editor.seekToStart(), { keys: ["home"] });
  add("end", () => editor.seekToEnd(), { keys: ["end"] });
}
