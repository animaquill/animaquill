import { kindOf } from "@animaquill/agent";
import {
  ChevronRight,
  Clapperboard,
  Laptop,
  ListChecks,
  MapPin,
  MoveRight,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { ServiceAvatar } from "./aiParts.tsx";
import styles from "./ChatPanel.module.css";
import { RefIcon } from "./RefChip.tsx";
import { kindOfRef, linkOf, piecesOf } from "./refs.ts";
import { suggestionsOf, type Suggestion } from "./suggestions.ts";
import { useChatUi } from "./ui.ts";

/** What each suggestion looks like before its words. */
const ICONS: Readonly<Record<Suggestion["key"], typeof Sparkles>> = {
  moveSelected: MoveRight,
  fadeSelected: Sparkles,
  problems: TriangleAlert,
  cutAssets: Clapperboard,
  titleScene: ListChecks,
  marker: MapPin,
};

/** The services people start with most, which the chat offers before any is set up. */
const FIRST_KINDS = ["anthropic", "openai", "deepseek"] as const;

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
    workbench.openSettings({ group: "models", depth: 2, adding: kind, back: "chat" });
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
      <button
        type="button"
        className={styles.serviceButton}
        data-testid="chat-onboard-local-ai"
        onClick={() => workbench.openLocalAiGuide()}
      >
        <Laptop size={20} aria-hidden className={styles.localAiIcon} />
        <span className={styles.serviceButtonText}>
          <strong>{t("localAi.entry.card")}</strong>
          <span className={styles.muted}>{t("localAi.entry.cardAbout")}</span>
        </span>
        <ChevronRight size={14} aria-hidden />
      </button>
      <button type="button" className={styles.link} onClick={() => add(true)}>
        {t("chat.onboard.more")}
      </button>
      <p className={styles.muted}>{t("chat.onboard.noSubscription")}</p>
    </div>
  );
}

/**
 * A conversation with nothing said yet: what is missing before AI can answer (a model that is on,
 * a key), with a button to that very place; else, at the foot of it, next to the box, a few things
 * to say, picked by how the project is right now (`suggestionsOf`), which go to the box, not out.
 */
export function EmptyStart(props: { readonly onExample: (text: string) => void }) {
  const workbench = useWorkbench();
  const { ai, chat, pointing, problems } = workbench;
  const ui = useChatUi();
  const { t } = useTranslation();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const pointed = useSyncExternalStore(pointing.subscribe, pointing.getSnapshot);
  const found = useSyncExternalStore(problems.subscribe, problems.getSnapshot);
  const view = useSyncExternalStore(workbench.timeline.subscribe, workbench.timeline.getSnapshot);
  const { store } = useSession();
  const state = useProject(store);
  const now = chat.modelNow();
  const go = (service?: string) => workbench.openSettings({ group: "models", depth: 2, service });
  const missing = (text: string, button: string, act: () => void) => (
    <div className={styles.missing} data-testid="chat-missing">
      <p>{text}</p>
      <button type="button" className={styles.primary} onClick={act}>
        {button}
      </button>
    </div>
  );
  if (!now) return missing(t("chat.missing.noModel"), t("chat.missing.enable"), () => go());
  const name = ai.modelOf(now.ref.service, now.ref.model)?.name ?? now.ref.model;
  if (now.state === "gone")
    return missing(t("chat.hold.modelGone"), t("chat.missing.otherModel"), () => ui.openModels());
  if (now.state === "off") {
    return missing(t("chat.missing.off", { model: name }), t("chat.missing.enable"), () =>
      go(now.ref.service),
    );
  }
  const service = now.service;
  // Online keys are the backend's: where it could not be read, there are none here, and the chat
  // says so over its box.
  const keysAway = workbench.accountAi?.getSnapshot().keysRead === false;
  // Kept on the backend, and it cannot open it any more (its master key changed).
  const unreadable =
    service !== undefined &&
    workbench.accountAi?.getSnapshot().unreadable?.includes(service.id) === true;
  if (
    service &&
    !keysAway &&
    !settings.keyed.has(service.id) &&
    (unreadable || !kindOf(service.kind)?.custom)
  ) {
    return missing(
      t(unreadable ? "chat.missing.unreadable" : "chat.missing.noKey", { service: service.name }),
      t("chat.missing.fillKey"),
      () => go(service.id),
    );
  }
  const timeline = view.model ? state?.timelines[view.model.id] : undefined;
  const playhead = view.model ? pointing.timeRef() : undefined;
  const suggestions = suggestionsOf({
    selectedClips: pointed.from === "timeline" ? pointed.count : 0,
    problems: found.errors + found.warnings,
    clips: timeline ? Object.keys(timeline.clips ?? {}).length : undefined,
    assets: Object.keys(state?.assets ?? {}).length,
    playhead: playhead && linkOf(playhead),
  });
  const say = t as unknown as (key: string, values: object) => string;
  return (
    <div className={styles.suggestions} data-testid="chat-suggestions">
      {suggestions.map(({ key, values }) => {
        const text = say(`chat.suggest.${key}`, {
          ...values,
          interpolation: { escapeValue: false },
        });
        const Icon = ICONS[key];
        return (
          <button
            key={key}
            type="button"
            className={styles.suggestion}
            data-testid="chat-suggestion"
            data-key={key}
            onClick={() => props.onExample(text)}
          >
            <Icon size={13} aria-hidden />
            <span>
              {/* Blocks as they look in the box, which is where they go: not links here. */}
              {piecesOf(text).map((piece, index) =>
                "ref" in piece ? (
                  <span key={index} className={styles.chip} data-kind={kindOfRef(piece.ref.href)}>
                    <RefIcon kind={kindOfRef(piece.ref.href)} />
                    <span className={styles.chipLabel}>{piece.ref.label}</span>
                  </span>
                ) : (
                  <span key={index}>{piece.text}</span>
                ),
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
