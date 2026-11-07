import { secondsOf } from "@animaquill/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { formatTimecode } from "../timeline/frames.ts";
import timelineStyles from "../timeline/TimelinePanel.module.css";
import type { KeyArea, ShownHandle, VisibleKey } from "./area.ts";
import { KEY_EASED, KEY_HOLD } from "./tables.ts";

/** The list for screen readers follows the view a moment later, not with every frame of a drag. */
const KEY_LIST_DELAY_MS = 80;
const KEY_LIST_LIMIT = 200;
const KEY_SIZE = 12;
const HANDLE_SIZE = 8;

const MARK_NAMES: Readonly<Record<number, string>> = {
  [KEY_EASED]: "eased",
  [KEY_HOLD]: "hold",
};

/** What is on the canvas, for those who cannot see it. Tests find keys by it too. */
export function KeyList({ area }: { area: KeyArea }) {
  const { keyframes } = area;
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const [keys, setKeys] = useState<readonly VisibleKey[]>([]);
  const [handles, setHandles] = useState<readonly ShownHandle[]>([]);
  const { model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown: readonly unknown[] = [];
    const update = () => {
      shown = area.whatIsDrawn;
      setKeys(area.visibleKeys(KEY_LIST_LIMIT));
      setHandles(area.visibleHandles());
    };
    const later = () => {
      // While playing nothing here moves, and frames of a busy page come slower than this waits.
      if (area.whatIsDrawn.every((item, index) => item === shown[index])) return;
      clearTimeout(timer);
      timer = setTimeout(update, KEY_LIST_DELAY_MS);
    };
    update();
    const stopView = keyframes.subscribeView(later);
    return () => {
      clearTimeout(timer);
      stopView();
    };
  }, [area, keyframes]);

  if (!model) return null;

  return (
    <div
      className={timelineStyles.clipList}
      role="listbox"
      aria-multiselectable="true"
      aria-label={t("keyframes.keys")}
    >
      {keys.map(({ id, lane, x, y, seconds, mark, selected, tried }) => (
        <div
          key={id}
          className={timelineStyles.clipItem}
          role="option"
          aria-selected={selected}
          aria-label={t("keyframes.keyLabel", {
            name: keyframes.labelOf(lane),
            time: formatTimecode(Math.round(seconds * model.rate.fps), model.rate),
          })}
          data-mark={MARK_NAMES[mark] ?? "linear"}
          data-kind={lane.node.kind}
          data-tried={tried || undefined}
          style={{
            left: x - KEY_SIZE / 2,
            top: y - KEY_SIZE / 2,
            width: KEY_SIZE,
            height: KEY_SIZE,
          }}
        />
      ))}
      {/* Handles are for the mouse. They are here to say where they are, for tests and tools. */}
      {handles.map(({ id, lane, box, time, side, x, y }) => (
        <div
          key={id}
          className={timelineStyles.clipItem}
          aria-hidden="true"
          data-handle={side}
          data-of={keyframes.labelOf(lane)}
          data-time={formatTimecode(
            Math.round((box.start + secondsOf(time) - box.offset) * model.rate.fps),
            model.rate,
          )}
          style={{
            left: x - HANDLE_SIZE / 2,
            top: y - HANDLE_SIZE / 2,
            width: HANDLE_SIZE,
            height: HANDLE_SIZE,
          }}
        />
      ))}
    </div>
  );
}
