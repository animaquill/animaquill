import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import styles from "./input.module.css";
import { useBoxMenu } from "./menu.ts";
import { useNudged } from "./nudge.ts";

/**
 * Why the pictures of the box cannot go as they are, where they cannot: the model takes none, it
 * is not known whether it does (they go, and the service decides), or one is still being made or
 * failed.
 */
export type PicturesWhy = "blind" | "unsure" | "working" | "failed";

/** What holds the pictures back, the worst first; nothing where they can go. */
export function picturesWhy(states: {
  readonly ready: number;
  readonly working: boolean;
  readonly failed: boolean;
  readonly sees: boolean | undefined;
}): PicturesWhy | undefined {
  if (states.failed) return "failed";
  if (states.working) return "working";
  if (states.ready > 0 && states.sees === false) return "blind";
  if (states.ready > 0 && states.sees === undefined) return "unsure";
  return undefined;
}

/** Only these hold the message back; "unsure" lets it go. */
export const holdsBack = (why: PicturesWhy | undefined): boolean =>
  why === "blind" || why === "working" || why === "failed";

/**
 * A small triangle at the end of the row of pictures (docs/design/chat-panel.md of AnimaQuill
 * Cloud, 3.2), in place of lines of words over the box: it says why on pointing at it, and opens to
 * what can be done — another model that takes pictures, or without them. It shakes when people
 * press send meanwhile.
 */
export function PicturesWarn(props: {
  readonly why: PicturesWhy;
  readonly model: string;
  readonly nudge: number;
  readonly onPickVision: () => void;
  /** Takes out what holds them back: the ones that failed, else all of them. */
  readonly onRemoveAll: () => void;
}) {
  const { t } = useTranslation();
  const { wrapRef, buttonRef, ...menu } = useBoxMenu();
  const shaking = useNudged(props.nudge);
  const { why } = props;
  const said =
    why === "blind"
      ? t("chat.pictures.warnBlind", { model: props.model, interpolation: { escapeValue: false } })
      : why === "unsure"
        ? t("chat.pictures.warnUnsure", {
            model: props.model,
            interpolation: { escapeValue: false },
          })
        : why === "working"
          ? t("chat.pictures.warnWorking")
          : t("chat.pictures.warnFailed");
  return (
    <div className={styles.menuWrap} ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className={styles.warn}
        data-why={why}
        data-shake={shaking ? "" : undefined}
        data-testid="chat-pictures-warn"
        aria-label={`${t("chat.pictures.warn")}：${said}`}
        title={said}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onPointerDown={(event) => event.preventDefault()}
        onClick={menu.onButtonClick}
        onKeyDown={menu.onButtonKeyDown}
      >
        <TriangleAlert size={14} aria-hidden />
      </button>
      {menu.open && (
        <div
          className={`${styles.menu} ${styles.menuEnd}`}
          role="menu"
          aria-label={said}
          onKeyDown={menu.onMenuKeyDown}
        >
          <p className={styles.menuNote}>{said}</p>
          {why === "blind" && (
            <button
              type="button"
              role="menuitem"
              data-testid="chat-pictures-vision"
              onClick={() => {
                menu.close();
                props.onPickVision();
              }}
            >
              {t("chat.pictures.pickVision")}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            data-testid="chat-pictures-remove-all"
            onClick={() => {
              menu.chosen();
              props.onRemoveAll();
            }}
          >
            {why === "failed" ? t("chat.pictures.removeFailedOnes") : t("chat.pictures.removeAll")}
          </button>
        </div>
      )}
    </div>
  );
}
