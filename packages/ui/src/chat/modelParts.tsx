import {
  MOST_HEADERS,
  headerProblem,
  looksSecret,
  tooManyHeaders,
  type FieldMark,
} from "@animaquill/agent";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useTranslation } from "react-i18next";
import styles from "./AiSettings.module.css";

/**
 * Where a cell's value comes from, beside it: "目录" (a catalog filled it in) or "你改的" (people
 * set it). People's can go back to what the catalogs say, from a small menu on it.
 */
export function Mark(props: {
  readonly mark: FieldMark;
  readonly onRevert?: (() => void) | undefined;
  readonly testId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  if (!props.mark) return null;
  if (props.mark === "catalog" || !props.onRevert)
    return (
      <span className={styles.mark} data-mark={props.mark} data-testid={props.testId}>
        {t(`ai.mark.${props.mark}`)}
      </span>
    );
  return (
    <span className={styles.markBox} ref={box}>
      <button
        type="button"
        className={styles.mark}
        data-mark={props.mark}
        data-testid={props.testId}
        aria-expanded={open}
        title={t("ai.mark.revertTitle")}
        onClick={() => setOpen(!open)}
      >
        {t(`ai.mark.${props.mark}`)}
      </button>
      {open && (
        <span className={styles.markMenu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.markItem}
            onClick={() => {
              setOpen(false);
              props.onRevert?.();
            }}
          >
            {t("ai.mark.revert")}
          </button>
        </span>
      )}
    </span>
  );
}

interface HeaderRow {
  readonly key: number;
  readonly name: string;
  readonly value: string;
}

const rowsOf = (headers: Readonly<Record<string, string>> | undefined): HeaderRow[] =>
  Object.entries(headers ?? {}).map(([name, value], key) => ({ key, name, value }));

/**
 * Headers people send to a service or a model, row by row. Rows that are being typed stay here
 * until they make a header that can be one (`headerProblem`): an empty or a wrong one is never
 * saved, nor more than `MOST_HEADERS`. A value that looks like a key is saved all the same, with a
 * reminder: headers go with the account as they are, and the key has its own place.
 */
export function HeadersEditor(props: {
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly disabled?: boolean;
  readonly onChange: (headers: Record<string, string>) => void;
  readonly testId?: string;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<HeaderRow[]>(() => rowsOf(props.headers));
  const next = useRef(rows.length);
  const saved = JSON.stringify(props.headers ?? {});
  const last = useRef(saved);
  // Another window changed them: what is saved shows, unless this one is typing.
  useEffect(() => {
    if (saved === last.current) return;
    last.current = saved;
    const fresh = rowsOf(props.headers);
    next.current = fresh.length;
    setRows(fresh);
  }, [saved, props.headers]);

  const problems = rows.map((row) =>
    row.name.trim() === "" && row.value === ""
      ? undefined
      : headerProblem(row.name.trim(), row.value),
  );
  const commit = (all: readonly HeaderRow[]) => {
    const headers: Record<string, string> = {};
    for (const row of all) {
      const name = row.name.trim();
      if (name !== "" && headerProblem(name, row.value) === undefined) headers[name] = row.value;
    }
    if (tooManyHeaders(headers)) return;
    const text = JSON.stringify(headers);
    if (text === last.current) return;
    last.current = text;
    props.onChange(headers);
  };
  const change = (key: number, field: "name" | "value", value: string) =>
    setRows((before) => before.map((row) => (row.key === key ? { ...row, [field]: value } : row)));

  return (
    <div className={styles.headers} data-testid={props.testId}>
      {rows.map((row, index) => (
        <div key={row.key} className={styles.headerRow}>
          <input
            className={`${styles.input} ${styles.mono}`}
            aria-label={t("ai.headers.name")}
            placeholder={t("ai.headers.name")}
            spellCheck={false}
            value={row.name}
            disabled={props.disabled}
            aria-invalid={problems[index] === "name"}
            onChange={(event) => change(row.key, "name", event.target.value)}
            onBlur={() => commit(rows)}
            onKeyDown={(event) => event.key === "Enter" && commit(rows)}
          />
          <input
            className={`${styles.input} ${styles.mono}`}
            aria-label={t("ai.headers.value")}
            placeholder={t("ai.headers.value")}
            spellCheck={false}
            value={row.value}
            disabled={props.disabled}
            aria-invalid={problems[index] === "value"}
            onChange={(event) => change(row.key, "value", event.target.value)}
            onBlur={() => commit(rows)}
            onKeyDown={(event) => event.key === "Enter" && commit(rows)}
          />
          <button
            type="button"
            className={styles.link}
            disabled={props.disabled}
            onClick={() => {
              const left = rows.filter((each) => each.key !== row.key);
              setRows(left);
              commit(left);
            }}
          >
            {t("ai.headers.remove")}
          </button>
          {problems[index] ? (
            <p className={styles.warning} data-testid="ai-header-problem">
              {t(`ai.headers.problem.${problems[index]}`)}
            </p>
          ) : (
            looksSecret(row.value) && (
              <p className={styles.warning} data-testid="ai-header-secret">
                {t("ai.headers.secret")}
              </p>
            )
          )}
        </div>
      ))}
      {tooManyHeaders(
        Object.fromEntries(rows.map((row) => [row.name.trim() || `#${row.key}`, row.value])),
      ) && (
        <p className={styles.warning} data-testid="ai-header-problem">
          {t("ai.headers.problem.many", { count: MOST_HEADERS })}
        </p>
      )}
      <button
        type="button"
        className={styles.link}
        style={{ alignSelf: "flex-start" }}
        disabled={props.disabled || rows.length >= MOST_HEADERS}
        onClick={() => {
          setRows((before) => [...before, { key: next.current, name: "", value: "" }]);
          next.current += 1;
        }}
      >
        {t("ai.headers.add")}
      </button>
    </div>
  );
}

/** Where a row was dragged to: before the row it is over, or after it, by where the pointer is. */
export const dropIndex = (event: DragEvent<HTMLElement>, index: number): number => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2 ? index + 1 : index;
};
