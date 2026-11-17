import type zhCN from "../i18n/zh-CN.json";
import type { Action, ActionRegistry } from "../workbench/actions.ts";
import type { TimelineEditor } from "./editor.ts";

export type TimelineAction = keyof typeof zhCN.timeline.action;

/**
 * Keys that show under the clips. While some are selected, what people do is about those and never
 * about clips, even though keys select their clips: what cannot be done to them says why instead.
 */
export interface LaneKeys {
  readonly hasSelection: boolean;
  /** Whether any of the selected keys that show here can change. */
  readonly canChangeSelection: boolean;
  readonly hasClipboard: boolean;
  nudge(frames: number): void;
  deleteSelected(): void;
  copySelected(): void;
  cutSelected(): void;
  paste(): void;
}

/** Keys as people know them from Premiere. Everything can be changed in the list of shortcuts. */
export function registerTimelineActions(
  actions: ActionRegistry,
  editor: TimelineEditor,
  keys: LaneKeys,
): void {
  const hasTimeline = () => editor.model !== undefined;
  const hasKeys = () => keys.hasSelection;
  const hasSelection = () => editor.getSnapshot().selection.size > 0;
  const toggleProperties = () => {
    const { extras, model } = editor;
    const { selection } = editor.getSnapshot();
    const boxes = [...selection].flatMap((id) => {
      const box = model?.boxes.get(id);
      return box && extras?.canOpen(box) ? [box] : [];
    });
    const closing = boxes.some((box) => extras?.isOpen(box));
    for (const box of boxes) if (extras?.isOpen(box) === closing) extras.toggle(box);
  };

  const add = (
    id: TimelineAction,
    run: () => void,
    {
      group,
      ...extra
    }: Pick<Action, "keys" | "repeats" | "enabled" | "selected" | "release"> & {
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
  add("addScene", () => editor.createScene(), { group: "add" });
  add("addSound", () => editor.createSound(), { group: "add" });
  add("addVideoTrack", () => editor.addTrack("video"), { group: "add" });
  add("addAudioTrack", () => editor.addTrack("audio"), { group: "add" });
  add("addCaptionTrack", () => editor.addTrack("caption"), { group: "add" });

  add("split", () => editor.splitAtPlayhead(), {
    keys: ["mod+k"],
    enabled: () => editor.canSplit,
    group: "edit",
  });
  // Ctrl+L, as in Premiere. Chrome and Firefox give it to the page first, and the address bar
  // does not get it when the page keeps it (tried with real key presses, 2026-11-17). The menu
  // says which of the two it does now.
  actions.register({
    id: "timeline.toggleLink",
    title: (t) => t("timeline.command", { action: t("timeline.action.toggleLink") }),
    run: () => editor.toggleLink(),
    keys: ["mod+l"],
    scope: "timeline",
    enabled: () => editor.canLink || editor.canUnlink,
    menu: {
      name: "timeline",
      group: "edit",
      title: (t) => t(editor.canUnlink ? "timeline.unlink" : "timeline.link"),
    },
  });
  add(
    "delete",
    () => {
      if (hasKeys()) keys.deleteSelected();
      else editor.deleteSelection();
    },
    {
      keys: ["delete", "backspace"],
      enabled: () => hasKeys() || editor.canChangeSelection,
      group: "edit",
    },
  );
  add("selectAll", () => editor.selectAll(), { keys: ["mod+a"], group: "edit" });
  add("toggleProperties", toggleProperties, { keys: ["u"], enabled: hasSelection, group: "edit" });
  const whileSelected = () => hasTimeline() && (hasSelection() || hasKeys());
  add(
    "copy",
    () => {
      if (hasKeys()) keys.copySelected();
      else editor.copySelection();
    },
    { keys: ["mod+c"], enabled: whileSelected, group: "clipboard" },
  );
  add(
    "cut",
    () => {
      if (hasKeys()) keys.cutSelected();
      else editor.cutSelection();
    },
    {
      keys: ["mod+x"],
      enabled: () => hasKeys() || editor.canCut,
      group: "clipboard",
    },
  );
  // There is one clipboard: copying clips lets go of keys, and copying keys of clips.
  add(
    "paste",
    () => {
      if (keys.hasClipboard) keys.paste();
      else editor.paste();
    },
    {
      keys: ["mod+v"],
      enabled: () => hasTimeline() && (editor.hasClipboard || keys.hasClipboard),
      group: "clipboard",
    },
  );

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
  // O is for the out, as in Premiere, which has no such switch. People can give it a key.
  add("toggleOverwriting", () => editor.toggleOverwriting(), { group: "tools" });
  add("toggleMultiSelecting", () => editor.toggleMultiSelecting(), { group: "tools" });

  add("zoomIn", () => editor.zoomIn(), { keys: ["="], repeats: true, group: "zoom" });
  add("zoomOut", () => editor.zoomOut(), { keys: ["-"], repeats: true, group: "zoom" });
  add("zoomToFit", () => editor.zoomToFit(), { keys: ["\\"], group: "zoom" });
  add("rowsTaller", () => editor.rowsTaller(), { keys: ["shift+="], repeats: true, group: "zoom" });
  add("rowsShorter", () => editor.rowsShorter(), {
    keys: ["shift+-"],
    repeats: true,
    group: "zoom",
  });

  // Space and J, K and L are for playing wherever people are, as are in and out.
  const everywhere = (
    id: TimelineAction,
    run: () => void,
    extra: Pick<Action, "keys" | "enabled" | "release" | "repeats"> = {},
    group = "play",
  ) =>
    actions.register({
      id: `timeline.${id}`,
      title: (t) => t("timeline.command", { action: t(`timeline.action.${id}`) }),
      run,
      enabled: hasTimeline,
      menu: { name: "timeline", group, title: (t) => t(`timeline.action.${id}`) },
      ...extra,
    });
  actions.register({
    id: "timeline.play",
    title: (t) => t("timeline.action.play"),
    run: () => editor.togglePlayback(),
    keys: ["space"],
    enabled: hasTimeline,
    menu: { name: "timeline", group: "play" },
  });
  const { shuttle } = editor;
  everywhere("shuttleBackward", () => shuttle.backward(), {
    keys: ["j"],
    release: () => shuttle.backwardUp(),
  });
  everywhere("shuttleStop", () => shuttle.stop(), {
    keys: ["k"],
    release: () => shuttle.stopUp(),
  });
  everywhere("shuttleForward", () => shuttle.forward(), {
    keys: ["l"],
    release: () => shuttle.forwardUp(),
  });
  everywhere("playInToOut", () => editor.playInToOut(), { keys: ["mod+shift+space"] });

  const hasIn = () => hasTimeline() && editor.marks.in !== undefined;
  const hasOut = () => hasTimeline() && editor.marks.out !== undefined;
  everywhere("markIn", () => editor.markIn(), { keys: ["i"] }, "marks");
  everywhere("markOut", () => editor.markOut(), { keys: ["o"] }, "marks");
  everywhere("markClip", () => editor.markClip(), { keys: ["x"] }, "marks");
  everywhere("goToIn", () => editor.goToIn(), { keys: ["shift+i"], enabled: hasIn }, "marks");
  everywhere("goToOut", () => editor.goToOut(), { keys: ["shift+o"], enabled: hasOut }, "marks");
  // Premiere clears one end with Ctrl+Shift+I and Ctrl+Shift+O, which Chrome keeps for itself.
  everywhere("clearIn", () => editor.clearIn(), { enabled: hasIn }, "marks");
  everywhere("clearOut", () => editor.clearOut(), { enabled: hasOut }, "marks");
  everywhere(
    "clearMarks",
    () => editor.clearMarks(),
    { keys: ["mod+shift+x"], enabled: () => hasTimeline() && editor.hasMarks },
    "marks",
  );
  // Markers, as in Premiere, but for the previous one: Ctrl+Shift+M opens the problems, as in VS
  // Code, and Chrome may keep it for switching people.
  everywhere("addMarker", () => editor.addMarker(), { keys: ["m"] }, "markers");
  everywhere(
    "nextMarker",
    () => editor.goToMarker(1),
    { keys: ["shift+m"], enabled: () => editor.hasMarkerFrom(1) },
    "markers",
  );
  everywhere(
    "previousMarker",
    () => editor.goToMarker(-1),
    { keys: ["alt+shift+m"], enabled: () => editor.hasMarkerFrom(-1) },
    "markers",
  );
  everywhere(
    "clearMarkersHere",
    () => editor.clearMarkersHere(),
    { keys: ["mod+alt+m"], enabled: () => editor.hasMarkerHere },
    "markers",
  );
  // Editors without sections have no key for it to follow.
  everywhere(
    "splitSection",
    () => editor.splitSectionAtPlayhead(),
    { enabled: () => editor.canSplitSection },
    "sections",
  );
  for (const [id, by, key] of [
    ["previousFrame", -1, "left"],
    ["nextFrame", 1, "right"],
  ] as const) {
    actions.register({
      id: `preview.${id}`,
      title: (t) => t("timeline.previewCommand", { action: t(`timeline.action.${id}`) }),
      run: () => editor.stepFrames(by),
      keys: [key],
      scope: "preview",
      repeats: true,
      enabled: hasTimeline,
    });
  }
  // Selected keys move by frames. Without any, the playhead does.
  const step = (frames: number) => () => {
    if (keys.canChangeSelection) keys.nudge(frames);
    else editor.stepFrames(frames);
  };
  add("previousFrame", step(-1), { keys: ["left"], repeats: true });
  add("nextFrame", step(1), { keys: ["right"], repeats: true });
  add("backFiveFrames", step(-5), { keys: ["shift+left"], repeats: true });
  add("forwardFiveFrames", step(5), { keys: ["shift+right"], repeats: true });
  add("previousEdit", () => editor.jumpToEdit(-1), { keys: ["up"], repeats: true });
  add("nextEdit", () => editor.jumpToEdit(1), { keys: ["down"], repeats: true });
  add("start", () => editor.seekToStart(), { keys: ["home"] });
  add("end", () => editor.seekToEnd(), { keys: ["end"] });
}
