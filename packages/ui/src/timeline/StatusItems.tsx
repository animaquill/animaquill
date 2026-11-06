import { projectFrameRate } from "@animaquill/core";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Bubble } from "../app/Bubble.tsx";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import { formatTimecode, frameAt, parseTimecode } from "./frames.ts";
import styles from "./StatusItems.module.css";

const COMMON_RATES = [
  { fps: "24000/1001", label: "23.976" },
  { fps: "24", label: "24" },
  { fps: "25", label: "25" },
  { fps: "30000/1001", label: "29.97" },
  { fps: "30", label: "30" },
  { fps: "50", label: "50" },
  { fps: "60000/1001", label: "59.94" },
  { fps: "60", label: "60" },
] as const;

function TimeBubble({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const { model } = timeline;
  const [invalid, setInvalid] = useState(false);
  if (!model) return null;
  const { rate } = model;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const current = parseTimecode(String(data.get("current")), rate);
    const total = parseTimecode(String(data.get("total")), rate);
    if (current === undefined || total === undefined) {
      setInvalid(true);
      return;
    }
    timeline.setEnd(total);
    timeline.seek(current);
    onClose();
  };

  return (
    <Bubble anchor={anchor} title={t("timeline.time")} onClose={onClose}>
      <form className={styles.form} onSubmit={onSubmit}>
        <label>
          {t("timeline.currentTime")}
          <input
            name="current"
            spellCheck={false}
            defaultValue={formatTimecode(timeline.frame, rate)}
          />
        </label>
        <label>
          {t("timeline.totalTime")}
          <input
            name="total"
            spellCheck={false}
            defaultValue={formatTimecode(frameAt(model.duration, rate), rate)}
          />
        </label>
        <p className={invalid ? styles.invalid : styles.hint}>
          {invalid ? t("timeline.timeInvalid") : t("timeline.timeHint")}
        </p>
        <button type="submit" className={styles.apply}>
          {t("timeline.apply")}
        </button>
      </form>
    </Bubble>
  );
}

/** Where the playhead is and how long the timeline is, for the left of the status bar. */
export function TimeStatus() {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const { model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const frame = useSyncExternalStore(timeline.subscribeView, () => timeline.frame);
  const [anchor, setAnchor] = useState<DOMRect>();
  if (!model) return null;

  return (
    <>
      <Tip name={t("timeline.time")} usage={t("timeline.help.time")}>
        <button
          type="button"
          className={styles.item}
          aria-label={t("timeline.time")}
          aria-haspopup="dialog"
          onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        >
          <output aria-label={t("timeline.playhead")} aria-live="off">
            {formatTimecode(frame, model.rate)}
          </output>
          {` | ${formatTimecode(frameAt(model.duration, model.rate), model.rate)}`}
        </button>
      </Tip>
      {anchor && <TimeBubble anchor={anchor} onClose={() => setAnchor(undefined)} />}
    </>
  );
}

function FrameRateBubble({
  anchor,
  current,
  onClose,
}: {
  anchor: DOMRect;
  current: string;
  onClose: () => void;
}) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const [invalid, setInvalid] = useState(false);
  const isCommon = COMMON_RATES.some(({ fps }) => fps === current);

  const apply = (fps: string) => {
    if (workbench.applyFrameRate(fps)) onClose();
    else setInvalid(true);
  };

  return (
    <Bubble anchor={anchor} title={t("project.frameRate")} onClose={onClose}>
      <div className={styles.rates} role="radiogroup" aria-label={t("project.frameRate")}>
        {COMMON_RATES.map(({ fps, label }) => (
          <button
            key={fps}
            type="button"
            role="radio"
            className={styles.rate}
            aria-checked={fps === current}
            {...(fps === current ? { "data-autofocus": true } : {})}
            onClick={() => apply(fps)}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className={styles.custom}
        onSubmit={(event) => {
          event.preventDefault();
          apply(String(new FormData(event.currentTarget).get("fps")));
        }}
      >
        <label>
          {t("timeline.customRate")}
          <input
            name="fps"
            spellCheck={false}
            placeholder="30000/1001"
            defaultValue={isCommon ? "" : current}
          />
        </label>
        <button type="submit" className={styles.apply}>
          {t("timeline.apply")}
        </button>
      </form>
      <p className={invalid ? styles.invalid : styles.hint}>
        {invalid ? t("notice.frameRateInvalid") : t("timeline.rateHint")}
      </p>
    </Bubble>
  );
}

/** The frame rate of the project. */
export function FrameRateStatus() {
  const workbench = useWorkbench();
  const { timeline } = workbench;
  const { t } = useTranslation();
  const { model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const [anchor, setAnchor] = useState<DOMRect>();
  const manifest = workbench.session.store?.getState().manifest;
  if (!model || !manifest) return null;

  return (
    <>
      <Tip name={t("project.frameRate")} usage={t("timeline.help.frameRate")}>
        <button
          type="button"
          className={styles.item}
          aria-label={t("project.frameRate")}
          aria-haspopup="dialog"
          onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        >
          {t("timeline.fps", { fps: Number(model.rate.fps.toFixed(3)) })}
        </button>
      </Tip>
      {anchor && (
        <FrameRateBubble
          anchor={anchor}
          current={projectFrameRate(manifest)}
          onClose={() => setAnchor(undefined)}
        />
      )}
    </>
  );
}
