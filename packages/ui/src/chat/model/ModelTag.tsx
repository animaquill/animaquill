import type { ReasoningLevel } from "@animaquill/agent";
import { ChevronDown } from "lucide-react";
import { forwardRef, useImperativeHandle, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { Tip } from "../../app/Tip.tsx";
import { useEffort } from "./effort.ts";
import { ModelBubble } from "./ModelBubble.tsx";
import styles from "./model.module.css";
import { nextEffort, shortName } from "./models.ts";

export interface ModelTagHandle {
  /** Opens the bubble; with `pictures`, only the models that take pictures light up. */
  open(pictures?: boolean): void;
  /** Opens the bubble, or closes it where it is open (`Alt+M`). */
  toggle(): void;
  /** How hard the model reasons, one step up, back to "自动" after the last (`Alt+R`). */
  cycleEffort(): void;
}

/**
 * The model of the conversation and how hard it reasons, as one tag at the end of the input card
 * (docs/design/chat-panel.md of AnimaQuill Cloud, 3.3): "GPT-6.1 Sol · 高", the name alone where
 * the model does not reason, its last word where the chat is narrow, yellow where the model was
 * turned off or its service taken away. It opens the bubble (`Alt+M`).
 */
export const ModelTag = forwardRef<
  ModelTagHandle,
  {
    readonly shortcut: string | undefined;
    /** The bubble closed from the keyboard or with a choice: the caret goes back to the box. */
    readonly onDone: () => void;
  }
>(function ModelTag(props, ref) {
  const { ai, chat } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const [open, setOpen] = useState<{ readonly pictures: boolean } | undefined>();
  const effort = useEffort();
  useImperativeHandle(
    ref,
    () => ({
      open: (pictures = false) => setOpen({ pictures }),
      toggle: () => {
        if (!open) setOpen({ pictures: false });
        else {
          setOpen(undefined);
          props.onDone();
        }
      },
      cycleEffort: () => {
        if (effort) chat.chooseReasoning(nextEffort(effort.levels, effort.chosen));
      },
    }),
    [chat, effort, open, props],
  );
  const now = chat.modelNow();
  const info = now && ai.modelOf(now.ref.service, now.ref.model);
  const name = info?.name ?? now?.ref.model ?? "";
  const level = (value: ReasoningLevel) => t(`ai.packs.value.reasoning.${value}`);
  const shown = effort?.chosen ?? effort?.auto;
  const levelText = shown ? level(shown) : effort ? t("chat.effort.auto") : undefined;
  const label = !now
    ? t("chat.modelNone")
    : now.state === "gone"
      ? t("chat.picker.gone", { model: name })
      : now.state === "off"
        ? t("chat.picker.off", { model: name })
        : name;
  const full =
    now?.service && now.state === "ok"
      ? [
          now.service.name,
          name,
          ...(effort
            ? [
                effort.chosen
                  ? t("chat.effort.tipLevel", { level: level(effort.chosen) })
                  : t("chat.effort.tipAuto", {
                      level: effort.auto ? level(effort.auto) : t("chat.effort.auto"),
                    }),
              ]
            : []),
        ].join(" · ")
      : t("chat.modelNoneTitle");
  const close = (back: boolean) => {
    setOpen(undefined);
    if (back) props.onDone();
  };
  return (
    <div className={styles.tagWrap} data-model-tag="">
      <Tip name={full} usage="" shortcut={props.shortcut}>
        <button
          type="button"
          className={styles.tag}
          data-testid="chat-model"
          data-state={now?.state}
          aria-haspopup="dialog"
          aria-expanded={open !== undefined}
          aria-label={`${t("chat.picker.label")}：${full}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => (open ? setOpen(undefined) : setOpen({ pictures: false }))}
        >
          <span className={styles.tagName}>
            <span className={styles.wideOnly} data-testid="chat-model-name">
              {label}
            </span>
            <span className={styles.narrowOnly} aria-hidden>
              {now?.state === "ok" ? shortName(name) : label}
            </span>
          </span>
          {levelText && now?.state === "ok" && (
            <span className={styles.tagLevel} data-testid="chat-model-level">
              {" · "}
              {levelText}
            </span>
          )}
          <ChevronDown size={12} aria-hidden className={styles.tagChevron} />
        </button>
      </Tip>
      {open && <ModelBubble effort={effort} pictures={open.pictures} onClose={close} />}
    </div>
  );
});
