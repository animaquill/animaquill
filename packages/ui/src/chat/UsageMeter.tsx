import type { ChatEntry } from "@animaquill/agent";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ChatPanel.module.css";
import { cacheShare, contextLevel, contextOf, dollars, percent, tokens, usageOf } from "./usage.ts";

/**
 * What the conversation took, in the bar on top: how full the context of the model is and what it
 * cost so far, yellow from 70 % and red from 90 %. Open, the tokens in and out, of the cache, the
 * cost and how much came from the cache. Nothing before the first answer that says.
 */
export function UsageMeter({ entries }: { readonly entries: readonly ChatEntry[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const total = usageOf(entries);
  const context = contextOf(entries);
  if (total.answers === 0 || !context) return null;
  const level = contextLevel(context.share);
  const head =
    context.share !== undefined
      ? percent(context.share)
      : `${t("chat.usage.in", { n: tokens(context.used) })}`;
  const hit = cacheShare(total);
  return (
    <div className={styles.meterWrap} ref={ref}>
      <button
        type="button"
        className={styles.meter}
        data-level={level}
        data-testid="chat-usage-total"
        aria-expanded={open}
        aria-label={t("chat.usage.title")}
        onClick={() => setOpen(!open)}
      >
        {context.share !== undefined && (
          <span
            className={styles.pie}
            style={{ ["--share" as string]: `${Math.min(100, context.share * 100)}%` }}
            aria-hidden="true"
          />
        )}
        <span>{head}</span>
        {total.cost !== undefined && (
          <span className={styles.meterCost}> · {dollars(total.cost)}</span>
        )}
      </button>
      {open && (
        <div className={styles.meterPanel} role="dialog" data-testid="chat-usage-panel">
          <div className={styles.meterTitle}>{t("chat.usage.title")}</div>
          <dl>
            <dt>{t("chat.usage.context")}</dt>
            <dd>
              {context.window
                ? t("chat.usage.contextOf", {
                    used: tokens(context.used),
                    window: tokens(context.window),
                  })
                : t("chat.usage.contextUnknown", { used: tokens(context.used) })}
            </dd>
            <dt>{t("chat.usage.input")}</dt>
            <dd>{tokens(total.input)}</dd>
            <dt>{t("chat.usage.output")}</dt>
            <dd>{tokens(total.output)}</dd>
            <dt>{t("chat.usage.cacheRead")}</dt>
            <dd>{tokens(total.cacheRead)}</dd>
            <dt>{t("chat.usage.cacheWrite")}</dt>
            <dd>{tokens(total.cacheWrite)}</dd>
            {hit !== undefined && (
              <>
                <dt>{t("chat.usage.cacheHit")}</dt>
                <dd>{percent(hit)}</dd>
              </>
            )}
            <dt>{t("chat.usage.cost")}</dt>
            <dd>{total.cost !== undefined ? dollars(total.cost) : t("chat.usage.noPrice")}</dd>
          </dl>
          {total.cost !== undefined && <p className={styles.muted}>{t("chat.usage.estimate")}</p>}
        </div>
      )}
    </div>
  );
}
