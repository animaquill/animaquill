import type { ReasoningLevel } from "@animaquill/agent";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import type { Effort } from "./effort.ts";
import styles from "./model.module.css";

/**
 * How hard the model reasons, at the top of the bubble (docs/design/chat-panel.md of AnimaQuill
 * Cloud, 4): "自动" (saying what it comes to), then each step the model takes, one click each, the
 * bubble staying open. "设为默认" shows only where the step chosen is not the model's default yet,
 * and "清除默认" where "自动" is chosen over a default people set.
 */
export function EffortBar({ effort }: { readonly effort: Effort }) {
  const { ai, chat } = useWorkbench();
  const { t } = useTranslation();
  const name = (level: ReasoningLevel) => t(`ai.packs.value.reasoning.${level}`);
  const steps: readonly (ReasoningLevel | undefined)[] = [undefined, ...effort.levels];
  const { chosen, starred } = effort;
  const choose = (level: ReasoningLevel | undefined) => chat.chooseReasoning(level);
  // As a group of radio buttons: ← and → go through the steps, choosing as they go.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const group = event.currentTarget;
    const at = steps.indexOf(chosen);
    const next = steps[(at + (event.key === "ArrowRight" ? 1 : -1) + steps.length) % steps.length];
    choose(next);
    requestAnimationFrame(() =>
      group.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus(),
    );
  };
  return (
    <div className={styles.effort}>
      <div className={styles.effortHead}>
        <span id="chat-effort-label">{t("chat.effort.label")}</span>
        {chosen !== undefined && chosen !== starred && (
          <button
            type="button"
            className={styles.textButton}
            data-testid="chat-effort-default"
            onClick={() => ai.setReasoning(effort.model, chosen)}
          >
            {t("chat.effort.setDefault")}
          </button>
        )}
        {chosen === undefined && starred !== undefined && (
          <button
            type="button"
            className={styles.textButton}
            data-testid="chat-effort-default"
            title={t("chat.effort.clearDefaultTitle", { level: name(starred) })}
            onClick={() => ai.setReasoning(effort.model, undefined)}
          >
            {t("chat.effort.clearDefault")}
          </button>
        )}
      </div>
      <div
        className={styles.segments}
        role="radiogroup"
        aria-labelledby="chat-effort-label"
        data-testid="chat-effort"
        onKeyDown={onKeyDown}
      >
        {steps.map((level) => {
          const on = level === chosen;
          return (
            <button
              key={level ?? "auto"}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              className={styles.segment}
              data-level={level ?? "auto"}
              data-default={level !== undefined && level === starred ? "" : undefined}
              data-testid="chat-effort-option"
              title={
                level !== undefined && level === starred ? t("chat.effort.isDefault") : undefined
              }
              onClick={() => choose(level)}
            >
              {level === undefined
                ? effort.auto
                  ? t("chat.effort.autoIs", { level: name(effort.auto) })
                  : t("chat.effort.auto")
                : name(level)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
