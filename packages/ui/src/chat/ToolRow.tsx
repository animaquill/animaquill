import type { ToolCallEntry, ToolEntry } from "@animaquill/agent";
import { Check, ChevronDown, ChevronRight, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./ChatPanel.module.css";
import { useNow } from "./clock.ts";
import { useOpened } from "./expanded.ts";
import { argFields, toolErrorCode, toolSummary, type Names, type Say } from "./toolSummary.ts";
import { durationText } from "./turns.ts";

/** How many lines of a result show before "show all". */
const RESULT_LINES = 12;
/** A call quicker than this says nothing of how long it took. */
const SHOWN_MS = 100;

/** A command by its type, as people know it from the command system: the tools before these. */
const commandOf = (tool: string) => tool.replaceAll("_", ".");

/**
 * A call of a tool in one line: whether it runs, went through or failed, the tool in words, what
 * it was about, how long it took. Open, its arguments as "name: value" lines and what it gave AI;
 * a failure says why in words first. A failed call comes open, and stays as people leave it.
 */
export function ToolRow({
  call,
  result,
  running,
  names,
}: {
  readonly call: ToolCallEntry;
  readonly result: ToolEntry | undefined;
  /** When it began, while it runs. */
  readonly running: number | undefined;
  readonly names: Names;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const failed = result !== undefined && !result.ok;
  const [open, setOpen] = useOpened(call.id, failed);
  const now = useNow(running !== undefined);
  const label = say(`chat.tool.${call.name}`, { defaultValue: commandOf(call.name) });
  const summary = toolSummary(say, call, result, names);
  const state =
    result === undefined
      ? running !== undefined
        ? "running"
        : "waiting"
      : result.ok
        ? "ok"
        : "failed";
  const ms =
    result?.startedAt !== undefined
      ? result.at - result.startedAt
      : running !== undefined
        ? now - running
        : undefined;
  return (
    <div className={styles.tool} data-state={state} data-testid="chat-tool">
      <button
        type="button"
        className={styles.toolHead}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className={styles.toolIcon}>
          {state === "ok" && <Check size={12} aria-label={t("chat.toolOk")} />}
          {state === "failed" && <X size={12} aria-label={t("chat.toolFailed")} />}
          {(state === "running" || state === "waiting") && (
            <LoaderCircle size={12} className={styles.spin} aria-label={t("chat.running")} />
          )}
        </span>
        <span className={styles.toolName}>{label}</span>
        <span className={styles.toolArgs} data-testid="chat-tool-summary">
          {summary}
        </span>
        {ms !== undefined && ms >= SHOWN_MS && (
          <span className={styles.toolMs}>{durationText(say, ms, true)}</span>
        )}
        <span className={styles.chevron}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>
      {open && <ToolBody call={call} result={result} />}
    </div>
  );
}

function ToolBody({
  call,
  result,
}: {
  readonly call: ToolCallEntry;
  readonly result: ToolEntry | undefined;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const [all, setAll] = useState(false);
  const fields = argFields(call.args);
  const code = result && toolErrorCode(result);
  const lines = result?.text.split("\n") ?? [];
  const shown = all ? lines : lines.slice(0, RESULT_LINES);
  return (
    <div className={styles.toolBody} data-testid="chat-tool-body">
      {fields.length > 0 && (
        <dl className={styles.fields}>
          {fields.map((field) => (
            <div
              key={field.key}
              className={styles.field}
              data-multiline={field.multiline || undefined}
            >
              <dt>{field.key}：</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {result && !result.ok && (
        <>
          <p className={styles.toolError} data-testid="chat-tool-error">
            {t("chat.toolText.failed", {
              reason: say(`chat.toolErrors.${code ?? "other"}`, {
                defaultValue: say("chat.toolErrors.other", { code: code ?? "?" }),
                code: code ?? "?",
              }),
            })}
          </p>
          <details className={styles.raw}>
            <summary>{t("chat.toolText.forAi")}</summary>
            <pre>{result.text}</pre>
          </details>
        </>
      )}
      {result?.ok && (
        <>
          <div className={styles.muted}>{t("chat.result")}</div>
          <pre>{shown.join("\n")}</pre>
          {lines.length > RESULT_LINES && (
            <button type="button" className={styles.more} onClick={() => setAll(!all)}>
              {all
                ? t("chat.toolText.showLess")
                : t("chat.toolText.showAll", { count: lines.length })}
            </button>
          )}
        </>
      )}
    </div>
  );
}
