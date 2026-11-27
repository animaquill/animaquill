import { formatAddress } from "@animaquill/tools";
import { Crosshair, X } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { formatTimecode } from "../../timeline/frames.ts";
import styles from "./input.module.css";

/**
 * "带上" under the box (docs/design/chat-panel.md of AnimaQuill Cloud, 3.5): what a message sent
 * now keeps of the editor, which AI can read (`aq_selection_read`, decision of 2026-11-15) — the
 * clips selected and the playhead. Pointed at, the clips light up on the timeline. × leaves them out
 * of the next message only (and says so, to put them back). The playhead does not run along while playing: it says where it
 * stopped. Nothing shows where there is no timeline.
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
  if (!props.on) {
    return (
      <div className={styles.carry} role="note" data-testid="chat-carry" data-off="">
        <Crosshair size={11} aria-hidden className={styles.carryIcon} />
        <span className={styles.carryText}>{t("chat.compose.carryOffNow")}</span>
        <button
          type="button"
          className={styles.textButton}
          data-testid="chat-carry-on"
          onPointerDown={(event) => event.preventDefault()}
          onClick={props.onToggle}
        >
          {t("chat.compose.carryOn")}
        </button>
      </div>
    );
  }
  const clips = [...selection];
  const time = formatTimecode(frame, model.rate);
  const pointClips = (on: boolean) =>
    workbench.pointAt(
      on ? formatAddress({ kind: "objects", ids: clips, timeline: model.id }) : undefined,
    );
  return (
    <div className={styles.carry} role="note" data-testid="chat-carry">
      <Crosshair size={11} aria-hidden className={styles.carryIcon} />
      <span className={styles.carryText}>
        <span className={styles.wideOnly}>{t("chat.compose.carry")}</span>
        {clips.length > 0 && (
          <>
            <span
              className={styles.carryPart}
              onPointerEnter={() => pointClips(true)}
              onPointerLeave={() => pointClips(false)}
              data-testid="chat-carry-clips"
            >
              <span className={styles.wideOnly}>
                {t("chat.compose.carryClips", { count: clips.length })}
              </span>
              <span className={styles.narrowOnly}>
                {t("chat.compose.carryClipsShort", { count: clips.length })}
              </span>
            </span>
            {" · "}
          </>
        )}
        <span className={styles.carryPart} data-testid="chat-carry-playhead">
          <span className={styles.wideOnly}>{t("chat.compose.carryPlayhead", { time })}</span>
          <span className={styles.narrowOnly}>{time}</span>
        </span>
      </span>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={t("chat.compose.carryOff")}
        title={t("chat.compose.carryOff")}
        data-testid="chat-carry-off"
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onToggle}
      >
        <X size={11} aria-hidden />
      </button>
    </div>
  );
}
