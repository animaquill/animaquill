import type { ChatEntry } from "@animaquill/agent";
import { DEFAULT_PACK, type ModelPack } from "@animaquill/tools";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { PackLabel } from "../PackLabel.tsx";
import { packLabel } from "../packText.ts";
import { OpenPackView } from "../PackViews.tsx";
import {
  cacheShare,
  contextLevel,
  contextOf,
  dollars,
  percent,
  tokens,
  usageOf,
} from "../usage.ts";
import styles from "./model.module.css";
import { packChoicesOf } from "./packChoices.ts";
import { packLinesOf } from "./packStatus.ts";

/**
 * How full the context of the model is, in the bar on top (docs/design/chat-panel.md of AnimaQuill
 * Cloud, 2.1): a small pie, yellow from 70 %, red from 90 %, without a number; pointed at, the share
 * and what the conversation cost. It opens the information of the conversation. Nothing before the
 * first answer that says.
 */
export function ContextPie(props: {
  readonly entries: readonly ChatEntry[];
  readonly open: boolean;
  readonly onOpen: () => void;
}) {
  const { t } = useTranslation();
  const total = usageOf(props.entries);
  const context = contextOf(props.entries);
  if (total.answers === 0 || !context) return null;
  const share = context.share;
  const said = [
    share !== undefined
      ? t("chat.info.pieShare", {
          share: percent(share),
          used: tokens(context.used),
          window: tokens(context.window ?? 0),
        })
      : t("chat.info.pieUsed", { used: tokens(context.used) }),
    ...(total.cost !== undefined ? [t("chat.info.pieCost", { cost: dollars(total.cost) })] : []),
  ].join(" · ");
  const angle = Math.min(1, share ?? 0) * 2 * Math.PI;
  const x = 7 + 6 * Math.sin(angle);
  const y = 7 - 6 * Math.cos(angle);
  return (
    <button
      type="button"
      className={styles.pie}
      data-level={contextLevel(share)}
      data-testid="chat-context"
      data-info-open=""
      aria-label={said}
      title={said}
      aria-expanded={props.open}
      aria-haspopup="dialog"
      onClick={props.onOpen}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r="6" className={styles.pieBack} />
        {share !== undefined &&
          (share >= 1 ? (
            <circle cx="7" cy="7" r="6" className={styles.pieFill} />
          ) : (
            <path
              className={styles.pieFill}
              d={`M7 7 L7 1 A6 6 0 ${angle > Math.PI ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`}
            />
          ))}
      </svg>
    </button>
  );
}

/**
 * What a conversation took and goes with, in one small card under the bar (docs/design/chat-panel.md
 * of AnimaQuill Cloud, 2.3): the context (with "压缩" where the earlier conversation can be summed
 * up), the cost, the tokens, the model, and its model pack — which one, what it goes without, what
 * the settings choose now (which this conversation can take from its next answer), the packs to
 * choose for the model, and all the model gets with it. Usage only once an answer said it.
 */
export function ConversationInfo(props: {
  readonly entries: readonly ChatEntry[];
  readonly onCompact: (() => void) | undefined;
  readonly onClose: () => void;
}) {
  const workbench = useWorkbench();
  const { ai, chat, packs } = workbench;
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const snapshot = useSyncExternalStore(packs.subscribe, packs.getSnapshot);
  const openView = useContext(OpenPackView);
  const ref = useRef<HTMLDivElement>(null);
  const [choosing, setChoosing] = useState(false);
  const [others, setOthers] = useState(false);
  const { onClose, entries } = props;
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (ref.current?.contains(target) || target?.closest?.("[data-info-open]")) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [onClose]);
  useEffect(() => ref.current?.focus(), []);

  const total = usageOf(entries);
  const context = contextOf(entries);
  const hit = cacheShare(total);
  const now = chat.modelNow();
  const model = now?.ref.model;
  const info = now && ai.modelOf(now.ref.service, now.ref.model);
  const lines = packLinesOf(t, entries, model, chat, packs);
  // The pack the conversation uses: as its newest answer with this model had it, else its choice.
  const last = entries.findLast((entry) => entry.role === "assistant");
  const usedId =
    last?.role === "assistant" && last.model === model && last.texts
      ? last.texts.id
      : model
        ? chat.choiceFor(model).pack.id
        : undefined;
  const used: ModelPack | undefined =
    usedId === DEFAULT_PACK.id ? DEFAULT_PACK : usedId ? packs.packOf(usedId) : undefined;
  const view = (pack: string, which: "readme" | "full") => {
    if (!model) return;
    onClose();
    openView?.({ view: which, pack, model });
  };
  const choices = model && now?.state === "ok" ? packChoicesOf(chat, model) : undefined;
  const pending =
    model && chat.repicking(model) && entries.length > 0 && choices
      ? t("chat.picker.packNext", {
          name: packLabel(t, choices.options.current, snapshot, !choices.options.chosen),
        })
      : t("chat.picker.packWhen");
  const choice = (pack: ModelPack, auto: boolean) => {
    const options = choices?.options;
    const checked = auto
      ? options?.chosen === false
      : options?.chosen === true && options.current.id === pack.id;
    return (
      <div
        key={`${auto ? "auto" : "pack"}-${pack.id}`}
        className={styles.packItem}
        data-testid="chat-pack-item"
        data-checked={checked ? "" : undefined}
      >
        <button
          type="button"
          role="radio"
          aria-checked={checked}
          className={styles.packChoose}
          onClick={() => model && chat.choosePack(model, auto ? undefined : pack.id, "now")}
        >
          <span className={styles.tick}>{checked && <Check size={12} aria-hidden />}</span>
          <PackLabel pack={pack} auto={auto} />
        </button>
        <button
          type="button"
          className={styles.textButton}
          data-testid="chat-pack-details"
          onClick={() => view(pack.id, "readme")}
        >
          {t("chat.picker.packDetails")}
        </button>
      </div>
    );
  };

  return (
    <div
      ref={ref}
      className={styles.info}
      role="dialog"
      tabIndex={-1}
      aria-label={t("chat.info.title")}
      data-testid="chat-info"
    >
      <dl className={styles.facts}>
        {context && (
          <>
            <dt>{t("chat.usage.context")}</dt>
            <dd>
              <span className={styles.factLine}>
                {context.window
                  ? t("chat.usage.contextOf", {
                      used: tokens(context.used),
                      window: tokens(context.window),
                    })
                  : t("chat.usage.contextUnknown", { used: tokens(context.used) })}
                {context.share !== undefined && (
                  <span className={styles.bar} data-level={contextLevel(context.share)}>
                    <span style={{ width: `${Math.min(100, context.share * 100)}%` }} />
                  </span>
                )}
                {props.onCompact && (
                  <button
                    type="button"
                    className={styles.textButton}
                    data-testid="chat-compact"
                    onClick={() => {
                      onClose();
                      props.onCompact?.();
                    }}
                  >
                    {t("chat.info.compact")}
                  </button>
                )}
              </span>
            </dd>
          </>
        )}
        {total.answers > 0 && (
          <>
            <dt>{t("chat.usage.cost")}</dt>
            <dd data-testid="chat-info-cost">
              {total.cost !== undefined
                ? t("chat.info.cost", { cost: dollars(total.cost) })
                : t("chat.usage.noPrice")}
            </dd>
            <dt>{t("chat.info.tokens")}</dt>
            <dd
              title={t("chat.usage.detail", {
                input: tokens(total.input),
                output: tokens(total.output),
                cacheRead: tokens(total.cacheRead),
                cacheWrite: tokens(total.cacheWrite),
              })}
            >
              {t("chat.info.inOut", {
                input: tokens(total.input + total.cacheRead + total.cacheWrite),
                output: tokens(total.output),
              })}
              {hit !== undefined && ` · ${t("chat.info.cacheHit", { share: percent(hit) })}`}
            </dd>
          </>
        )}
        {now?.service && (
          <>
            <dt>{t("chat.info.model")}</dt>
            <dd>
              {t("chat.info.modelOf", {
                model: info?.name ?? now.ref.model,
                service: now.service.name,
              })}
            </dd>
          </>
        )}
        {used && (
          <>
            <dt>{t("chat.info.pack")}</dt>
            <dd className={styles.packFact} data-testid="chat-info-pack">
              <span className={styles.factLine}>
                <PackLabel
                  pack={used}
                  auto={
                    choices?.options.chosen === false && used.id === choices.options.recommended.id
                  }
                />
                {choices && (
                  <button
                    type="button"
                    className={styles.textButton}
                    data-testid="chat-info-pack-choose"
                    aria-expanded={choosing}
                    onClick={() => setChoosing(!choosing)}
                  >
                    {t("chat.info.packChoose")}
                    {choosing ? (
                      <ChevronDown size={11} aria-hidden />
                    ) : (
                      <ChevronRight size={11} aria-hidden />
                    )}
                  </button>
                )}
              </span>
              {lines
                .filter((line) => line.testId !== "chat-pack")
                .map((line) => (
                  <span key={line.testId} className={styles.factNote} data-testid={line.testId}>
                    {line.text}
                    {line.take && (
                      <button
                        type="button"
                        className={styles.textButton}
                        data-testid="chat-info-pack-now"
                        onClick={() => {
                          const take = line.take;
                          if (take) chat.choosePack(take.model, take.pack, "now");
                        }}
                      >
                        {t("chat.info.packTake")}
                      </button>
                    )}
                  </span>
                ))}
              {choosing && choices && (
                <div
                  className={styles.packs}
                  role="radiogroup"
                  aria-label={t("chat.picker.packFor", { model: info?.name ?? model })}
                  data-testid="chat-pack-menu"
                >
                  {choice(choices.options.recommended, true)}
                  {choices.fits.map((pack) => choice(pack, false))}
                  {choices.others.length > 0 && (
                    <button
                      type="button"
                      className={styles.textButton}
                      data-testid="chat-pack-others-open"
                      aria-expanded={others}
                      onClick={() => setOthers(!others)}
                    >
                      {t("chat.picker.others", { count: choices.others.length })}
                    </button>
                  )}
                  {others && (
                    <div data-testid="chat-pack-others">
                      {choices.others.map((pack) => choice(pack, false))}
                    </div>
                  )}
                  <p className={styles.factNote} data-testid="chat-pack-when">
                    {pending}
                  </p>
                </div>
              )}
            </dd>
          </>
        )}
      </dl>
      {model && used && (
        <button
          type="button"
          className={styles.textButton}
          data-testid="chat-info-sent"
          onClick={() => view(used.id, "full")}
        >
          {t("chat.info.sent")}
          <ChevronRight size={11} aria-hidden />
        </button>
      )}
    </div>
  );
}
