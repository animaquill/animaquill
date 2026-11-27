import { TriangleAlert } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import type { ChatHold } from "../session.ts";
import styles from "./input.module.css";
import { useNudged } from "./nudge.ts";

/** What each hold offers to do about it: where to go, or nothing. */
const ACTION: Readonly<Record<ChatHold, "settings" | "model" | "signIn" | undefined>> = {
  noProject: undefined,
  noService: "settings",
  noModel: "settings",
  badUrl: "settings",
  relayMissing: "settings",
  relayUrl: "settings",
  relaySignIn: "signIn",
  modelGone: "model",
  modelOff: "model",
  // The pictures say so themselves, over the box.
  noPictures: undefined,
};

/**
 * Why a message cannot go now, in one thin line over the box (docs/design/chat-panel.md of
 * AnimaQuill Cloud, 7): a few words and the one thing to do about it. Online, the keys that are on
 * the backend while it cannot be reached say so here too, with a way to try again. The line shakes
 * when people press send meanwhile.
 */
export function HoldStrip(props: {
  readonly hold: ChatHold | undefined;
  readonly onModel: () => void;
  /** Changes each time people try to send while held. */
  readonly nudge: number;
}) {
  const workbench = useWorkbench();
  const { accountAi } = workbench;
  const { t } = useTranslation();
  const keys = useSyncExternalStore(
    accountAi?.subscribe ?? noSubscribe,
    accountAi?.getSnapshot ?? noKeys,
  );
  const shaking = useNudged(props.nudge);
  const away = accountAi !== undefined && !keys.keysRead && keys.status !== "reading";
  const hold = props.hold === "noPictures" ? undefined : props.hold;
  if (!hold && !away) return null;
  const action = hold && ACTION[hold];
  return (
    <div className={styles.strips}>
      {away && (
        <p
          className={styles.strip}
          role="alert"
          data-testid="chat-keys-away"
          data-shake={shaking ? "" : undefined}
        >
          <TriangleAlert size={12} aria-hidden className={styles.stripIcon} />
          <span className={styles.stripText}>{t("chat.keysAway")}</span>
          <button type="button" className={styles.textButton} onClick={() => void accountAi.pull()}>
            {t("chat.keysAwayRetry")}
          </button>
        </p>
      )}
      {hold && (
        <p
          className={styles.strip}
          role="alert"
          data-testid="chat-hold"
          data-why={hold}
          data-shake={shaking ? "" : undefined}
        >
          <TriangleAlert size={12} aria-hidden className={styles.stripIcon} />
          <span className={styles.stripText}>{t(`chat.hold.${hold}`)}</span>
          {action === "settings" && (
            <button
              type="button"
              className={styles.textButton}
              onClick={() => workbench.openSettings({ group: "models", depth: 1 })}
            >
              {t("chat.hold.toSettings")}
            </button>
          )}
          {action === "model" && (
            <button type="button" className={styles.textButton} onClick={props.onModel}>
              {t("chat.hold.otherModel")}
            </button>
          )}
          {action === "signIn" && workbench.account && (
            <button
              type="button"
              className={styles.textButton}
              onClick={() => void workbench.signIn()}
            >
              {t("account.signIn")}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

const noSubscribe = () => () => {};
const NO_KEYS = { status: "ready", keysRead: true, pending: 0 } as const;
const noKeys = () => NO_KEYS;
