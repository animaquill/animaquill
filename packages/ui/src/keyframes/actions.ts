import { standsFor } from "../mixer/track-clip.ts";
import type zhCN from "../i18n/zh-CN.json";
import { keyEdit } from "../properties/inspect.ts";
import type { PropertyWriter } from "../properties/writer.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import type { Action, ActionRegistry } from "../workbench/actions.ts";
import type { KeyframeEditor } from "./editor.ts";

export type KeyframeAction = keyof typeof zhCN.keyframes.action;

/** Keys that mean the same as on the timeline, for what can be done with keys. */
export function registerKeyframeActions(
  actions: ActionRegistry,
  keyframes: KeyframeEditor,
  timeline: TimelineEditor,
  properties: PropertyWriter,
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
  // No key of its own, as in After Effects: it is a few clicks a day at most.
  add("reverse", () => keyframes.reverseSelected(), { enabled: () => keyframes.canReverse() });
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

  // A key at the playhead for the property people worked with last, on a selected clip, wherever
  // they are. Alt+K as in Final Cut Pro: Premiere has no key for it, and its letters are all taken,
  // K by J, K and L.
  const keyNow = () => {
    const last = properties.lastProperty;
    const { selection, track } = timeline.getSnapshot();
    // A selected track of sound is a clip of its own here, see `withTrackClip`.
    const ofTrack = last && standsFor(last.clip);
    const selected =
      last !== undefined && (ofTrack === undefined ? selection.has(last.clip) : ofTrack === track);
    const box = selected ? keyframes.model?.boxes.get(last.clip) : undefined;
    const now = box && last && keyframes.inspect(box, last.spec);
    if (!last || !now || now.blocked !== undefined || last.spec.animatable === false) return;
    return keyEdit(last.clip, now.row, now.time);
  };
  actions.register({
    id: "keyframes.toggleKey",
    title: (t) => t("keyframes.command", { action: t("keyframes.action.toggleKey") }),
    run: () => {
      const edit = keyNow();
      if (edit) properties.commit([edit]);
    },
    keys: ["alt+k"],
    enabled: () => keyNow() !== undefined,
    menu: { name: "timeline", group: "keys", title: (t) => t("keyframes.action.toggleKey") },
  });

  // The same for every property of the object around it, as the diamond of the object does.
  const objectKeys = () => {
    const last = properties.lastProperty;
    if (!last || !timeline.getSnapshot().selection.has(last.clip)) return;
    const object = keyframes.objectAround(last.clip, last.spec.path);
    const keys = object && keyframes.objectKeyEdits(last.clip, object);
    return keys && keys.edits.length > 0 ? keys.edits : undefined;
  };
  actions.register({
    id: "keyframes.toggleObjectKeys",
    title: (t) => t("keyframes.command", { action: t("keyframes.action.toggleObjectKeys") }),
    run: () => {
      const edits = objectKeys();
      if (edits) properties.commit(edits);
    },
    keys: ["alt+shift+k"],
    enabled: () => objectKeys() !== undefined,
    menu: {
      name: "timeline",
      group: "keys",
      title: (t) => t("keyframes.action.toggleObjectKeys"),
    },
  });

  // No key of its own: forgetting it is on writes keys nobody meant, so it takes a look to turn on.
  actions.register({
    id: "keyframes.toggleRecording",
    title: (t) => t("keyframes.command", { action: t("keyframes.action.toggleRecording") }),
    run: () => properties.toggleRecording(),
  });
}
