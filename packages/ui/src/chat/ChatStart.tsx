import { kindOf } from "@animaquill/agent";
import { ChevronRight } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ServiceAvatar } from "./aiParts.tsx";
import styles from "./ChatPanel.module.css";

/** The services people start with most, which the chat offers before any is set up. */
const FIRST_KINDS = ["anthropic", "openai", "deepseek"] as const;
/** What a new conversation offers to say, which goes to the input box, not out. */
const EXAMPLES = ["subtitles", "slower", "marker", "problems"] as const;

/**
 * The chat before any service is set up: where the key goes (from this browser to the service, not
 * through us), the three services people start with most, and all the others. Each goes straight
 * to adding that service, and back to the chat after.
 */
export function Onboarding() {
  const workbench = useWorkbench();
  const { ai } = workbench;
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  useEffect(() => {
    for (const kind of FIRST_KINDS) void ai.loadKnown(kind);
  }, [ai]);
  const add = (kind: true | string) =>
    workbench.openSettings({ page: "models", depth: 2, adding: kind, back: "chat" });
  return (
    <div className={styles.onboard} data-testid="chat-onboarding">
      <h3>{t("chat.onboard.title")}</h3>
      <p className={styles.muted}>{t("chat.onboard.text")}</p>
      {FIRST_KINDS.map((id) => {
        const kind = kindOf(id);
        if (!kind) return null;
        const count = settings.known.get(id)?.length;
        return (
          <button
            key={id}
            type="button"
            className={styles.serviceButton}
            data-testid="chat-onboard-service"
            data-kind={id}
            onClick={() => add(id)}
          >
            <ServiceAvatar kind={id} name={kind.name} />
            <span className={styles.serviceButtonText}>
              <strong>{kind.name}</strong>
              <span className={styles.muted}>
                {t(`chat.onboard.about.${id}`)}
                {count ? ` · ${t("chat.onboard.models", { count })}` : ""}
              </span>
            </span>
            <ChevronRight size={14} aria-hidden />
          </button>
        );
      })}
      <button type="button" className={styles.link} onClick={() => add(true)}>
        {t("chat.onboard.more")}
      </button>
      <p className={styles.muted}>{t("chat.onboard.noSubscription")}</p>
    </div>
  );
}

/**
 * The top of a conversation with nothing said yet: what is missing before AI can answer (a model
 * that is on, a key), with a button to that very place; else a few things to try saying, which go
 * to the input box.
 */
export function EmptyStart(props: { readonly onExample: (text: string) => void }) {
  const workbench = useWorkbench();
  const { ai, chat } = workbench;
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const now = chat.modelNow();
  const go = (service?: string) => workbench.openSettings({ page: "models", depth: 2, service });
  const missing = (text: string, button: string, service?: string) => (
    <div className={styles.missing} data-testid="chat-missing">
      <p>{text}</p>
      <button type="button" className={styles.primary} onClick={() => go(service)}>
        {button}
      </button>
    </div>
  );
  if (!now) return missing(t("chat.missing.noModel"), t("chat.missing.enable"));
  const name = ai.modelOf(now.ref.service, now.ref.model)?.name ?? now.ref.model;
  if (now.state === "gone") return missing(t("chat.hold.modelGone"), t("chat.missing.choose"));
  if (now.state === "off") {
    return missing(
      t("chat.missing.off", { model: name }),
      t("chat.missing.enable"),
      now.ref.service,
    );
  }
  const service = now.service;
  if (service && !settings.keyed.has(service.id) && !kindOf(service.kind)?.custom) {
    return missing(
      t("chat.missing.noKey", { service: service.name }),
      t("chat.missing.fillKey"),
      service.id,
    );
  }
  return (
    <div className={styles.examples} data-testid="chat-examples">
      <p className={styles.muted}>{t("chat.empty")}</p>
      <p className={styles.muted}>{t("chat.examples.title")}</p>
      {EXAMPLES.map((each) => (
        <button
          key={each}
          type="button"
          className={styles.example}
          onClick={() => props.onExample(t(`chat.examples.${each}`))}
        >
          {t(`chat.examples.${each}`)}
        </button>
      ))}
    </div>
  );
}
