import { formatAddress } from "@animaquill/tools";
import { Boxes, Clock, Plus, X } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { formatTimecode } from "../../timeline/frames.ts";
import styles from "./input.module.css";

/**
 * "带上" at the top of the card, over the words, as the context of VS Code's chat is (docs/design/
 * chat-panel.md of AnimaQuill Cloud, 3.5): what a message sent now keeps of the editor, which AI can
 * read (`aq_selection_read`, decision of 2026-11-15) — the clips selected and the playhead, an icon
 * and a short name each. Pointed at, the clips light up on the timeline.
 *
 * Both go with a message or neither does, as AI is told "the user did not share the selection" of
 * all of it: so they are one tag, and its × takes them off. Off, the tag stays, slanted and struck
 * through, and a click on it puts them back. People's choice stays for the messages after, and goes
 * with their AI settings (`carrySelection`). The playhead does not run along while playing: it says
 * where it stopped. With nothing selected it is the playhead alone.
 */
export function CarryLine(props: { readonly on: boolean; readonly onToggle: () => void }) {
  const workbench = useWorkbench();
  const { timeline } = workbench;
  const { t } = useTranslation();
  const view = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  // Where the playhead was last at rest; while playing, that stays.
  const rest = useRef(timeline.frame);
  const frame = useSyncExternalStore(timeline.subscribeView, () => {
    if (!timeline.getSnapshot().playing) rest.current = timeline.frame;
    return rest.current;
  });
  const { model, selection } = view;
  if (!model) return null;
  const { on, onToggle } = props;
  const clips = [...selection];
  const time = formatTimecode(frame, model.rate);
  const clipsName = t("chat.compose.carryClips", { count: clips.length });
  const playheadName = t("chat.compose.carryPlayhead", { time });
  const what =
    clips.length === 0
      ? playheadName
      : t("chat.compose.carryBoth", { clips: clipsName, playhead: playheadName });
  const withIt = t("chat.compose.carryWith", { what });
  const label = on ? withIt : t("chat.compose.carryWithout", { what });
  const off = t(clips.length === 0 ? "chat.compose.carryOffPlayhead" : "chat.compose.carryOff");
  const pointClips = (pointing: boolean) =>
    workbench.pointAt(
      pointing && clips.length > 0
        ? formatAddress({ kind: "objects", ids: clips, timeline: model.id })
        : undefined,
    );
  const parts = (
    <>
      {clips.length > 0 && (
        <span
          className={styles.carryPart}
          onPointerEnter={() => pointClips(true)}
          onPointerLeave={() => pointClips(false)}
          data-testid="chat-carry-clips"
        >
          <Boxes size={12} aria-hidden className={styles.carryIcon} />
          <span className={`${styles.carryName} ${styles.wideOnly}`}>{clipsName}</span>
          <span className={`${styles.carryName} ${styles.narrowOnly}`}>
            {t("chat.compose.carryClipsShort", { count: clips.length })}
          </span>
        </span>
      )}
      <span className={styles.carryPart} data-testid="chat-carry-playhead">
        <Clock size={12} aria-hidden className={styles.carryIcon} />
        <span className={`${styles.carryName} ${styles.wideOnly}`}>{playheadName}</span>
        <span className={`${styles.carryName} ${styles.narrowOnly}`}>{time}</span>
      </span>
    </>
  );
  // A click on the tag leaves the words where they were being written.
  const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();
  return (
    <div
      className={styles.carry}
      role="group"
      aria-label={label}
      title={label}
      data-testid="chat-carry"
      data-off={on ? undefined : ""}
    >
      {on ? (
        <>
          {parts}
          <button
            type="button"
            className={styles.carryToggle}
            aria-label={off}
            title={off}
            data-testid="chat-carry-off"
            onPointerDown={keepFocus}
            onClick={onToggle}
          >
            <X size={11} aria-hidden />
          </button>
        </>
      ) : (
        <button
          type="button"
          className={styles.carryBack}
          aria-label={withIt}
          title={label}
          data-testid="chat-carry-on"
          onPointerDown={keepFocus}
          onClick={onToggle}
        >
          {parts}
          <span className={styles.carryToggle} aria-hidden>
            <Plus size={11} />
          </span>
        </button>
      )}
    </div>
  );
}
