import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Bubble } from "../app/Bubble.tsx";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import { QUALITY_CHOICES, type QualityChoice, type QualityScale } from "./quality.ts";
import styles from "./Quality.module.css";

const SCALE_NAMES: Readonly<Record<QualityScale, Exclude<QualityChoice, "auto">>> = {
  1: "full",
  0.5: "half",
  0.25: "quarter",
};

/** The name of a choice, with what automatic stands for right now. */
function useChoiceName() {
  const { t } = useTranslation();
  return (choice: QualityChoice, scale: QualityScale) =>
    choice === "auto"
      ? t("preview.quality.autoNow", { scale: t(`preview.quality.${SCALE_NAMES[scale]}`) })
      : t(`preview.quality.${choice}`);
}

/** Where people choose how sharp the preview is. */
function QualityBubble({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const { previewQuality } = useWorkbench();
  const { t } = useTranslation();
  const { choice, scale } = useSyncExternalStore(
    previewQuality.subscribe,
    previewQuality.getSnapshot,
  );
  const name = useChoiceName();
  return (
    <Bubble anchor={anchor} title={t("preview.quality.label")} onClose={onClose}>
      <div className={styles.choices} role="radiogroup" aria-label={t("preview.quality.label")}>
        {QUALITY_CHOICES.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            className={styles.choice}
            aria-checked={choice === id}
            {...(choice === id ? { "data-autofocus": true } : {})}
            onClick={() => {
              previewQuality.choose(id);
              onClose();
            }}
          >
            <strong>{id === choice ? name(id, scale) : t(`preview.quality.${id}`)}</strong>
            <span>{t(`preview.quality.about.${id}`)}</span>
          </button>
        ))}
      </div>
      <p className={styles.note}>{t("preview.quality.decodeNote")}</p>
    </Bubble>
  );
}

/** On the toolbar of the preview, next to what it is about. */
export function QualityButton() {
  const { previewQuality } = useWorkbench();
  const { t } = useTranslation();
  const { choice } = useSyncExternalStore(previewQuality.subscribe, previewQuality.getSnapshot);
  const [anchor, setAnchor] = useState<DOMRect>();
  return (
    <>
      <Tip name={t("preview.quality.label")} usage={t("preview.quality.usage")}>
        <button
          type="button"
          className={styles.button}
          aria-label={t("preview.quality.label")}
          aria-haspopup="dialog"
          onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        >
          {t("preview.quality.button", { choice: t(`preview.quality.${choice}`) })}
        </button>
      </Tip>
      {anchor && <QualityBubble anchor={anchor} onClose={() => setAnchor(undefined)} />}
    </>
  );
}

/** Rounded the way the frame rate of the project is shown. */
const shownRate = (fps: number) => Number(fps.toFixed(2));

/**
 * How the preview is doing, for the right of the status bar: the quality it draws at and, while
 * playing, how many frames it really shows. It changes all the time, and opens the same choices as
 * the button of the preview.
 */
export function PreviewStatus() {
  const { previewQuality, frameRate } = useWorkbench();
  const { t } = useTranslation();
  const { choice, scale, size } = useSyncExternalStore(
    previewQuality.subscribe,
    previewQuality.getSnapshot,
  );
  const frames = useSyncExternalStore(frameRate.subscribe, frameRate.getSnapshot);
  const [anchor, setAnchor] = useState<DOMRect>();
  const name = useChoiceName();
  if (!size) return null;
  const reading = frames.state === "playing" ? frames.reading : undefined;
  const short = t(`preview.status.scale.${SCALE_NAMES[scale]}`);
  const quality = choice === "auto" ? t("preview.status.auto", { scale: short }) : short;
  const value = reading
    ? t("preview.status.playing", { quality, painted: reading.painted })
    : t("preview.status.value", { quality });
  const framesUsage = reading
    ? t("preview.frameRate.playing", {
        painted: reading.painted,
        fps: shownRate(reading.fps),
        dropped: reading.dropped,
      })
    : t(frames.state === "playing" ? "preview.frameRate.waiting" : "preview.frameRate.paused");
  const usage = t("preview.status.usage", {
    choice: name(choice, scale),
    width: size.shown.width,
    height: size.shown.height,
    fullWidth: size.full.width,
    fullHeight: size.full.height,
    frames: framesUsage,
  });
  return (
    <>
      <Tip name={t("preview.status.name")} usage={usage}>
        <button
          type="button"
          className={styles.status}
          data-short={reading?.short || undefined}
          aria-label={t("preview.status.label", { value })}
          aria-haspopup="dialog"
          onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        >
          {value}
        </button>
      </Tip>
      {anchor && <QualityBubble anchor={anchor} onClose={() => setAnchor(undefined)} />}
    </>
  );
}
