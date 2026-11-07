import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Bubble } from "../app/Bubble.tsx";
import { Tip } from "../app/Tip.tsx";
import { useWorkbench } from "../app/context.ts";
import { QUALITY_CHOICES, type QualityChoice, type QualityScale } from "./quality.ts";
import styles from "./Quality.module.css";

const SCALE_NAMES: Readonly<Record<QualityScale, QualityChoice>> = {
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
  const { choice, scale } = useSyncExternalStore(
    previewQuality.subscribe,
    previewQuality.getSnapshot,
  );
  const [anchor, setAnchor] = useState<DOMRect>();
  const name = useChoiceName();
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
          {t("preview.quality.button", { choice: name(choice, scale) })}
        </button>
      </Tip>
      {anchor && <QualityBubble anchor={anchor} onClose={() => setAnchor(undefined)} />}
    </>
  );
}

/** What the preview really draws at, for the status bar. */
export function ResolutionStatus() {
  const { previewQuality } = useWorkbench();
  const { t } = useTranslation();
  const { choice, scale, size } = useSyncExternalStore(
    previewQuality.subscribe,
    previewQuality.getSnapshot,
  );
  const [anchor, setAnchor] = useState<DOMRect>();
  const name = useChoiceName();
  if (!size) return null;
  const { width, height } = size.shown;
  const usage = t("preview.quality.statusUsage", {
    choice: name(choice, scale),
    fullWidth: size.full.width,
    fullHeight: size.full.height,
  });
  return (
    <>
      <Tip name={t("preview.quality.statusName")} usage={usage}>
        <button
          type="button"
          className={styles.status}
          aria-label={t("preview.quality.statusLabel", { width, height })}
          aria-haspopup="dialog"
          onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        >
          {t("preview.quality.status", { width, height })}
        </button>
      </Tip>
      {anchor && <QualityBubble anchor={anchor} onClose={() => setAnchor(undefined)} />}
    </>
  );
}
