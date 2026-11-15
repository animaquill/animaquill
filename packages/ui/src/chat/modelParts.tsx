import { MOST_HEADERS, headerProblem, tooManyHeaders, type FieldMark } from "@animaquill/agent";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
} from "react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./AiSettings.module.css";

/**
 * A cell people changed from what the catalogs filled in, with a thin line on its left (docs/design/
 * settings-and-properties.md of AnimaQuill Cloud, 6.2): hovering it says so, a click opens a menu to
 * go back to the catalog's value. What a catalog filled in is not marked: most cells are.
 */
export function Marked(props: {
  readonly mark: FieldMark;
  readonly onRevert?: (() => void) | undefined;
  readonly testId?: string;
  readonly children: ReactNode;
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
  const edited = props.mark === "edited";
  const said = edited ? t("ai.mark.edited") : undefined;
  return (
    <span className={styles.marked} ref={box}>
      {edited &&
        (props.onRevert ? (
          <button
            type="button"
            className={styles.markBar}
            data-mark="edited"
            data-testid={props.testId}
            aria-label={said}
            aria-expanded={open}
            title={said}
            onClick={() => setOpen(!open)}
          />
        ) : (
          <span
            className={styles.markBar}
            data-mark="edited"
            data-testid={props.testId}
            role="img"
            aria-label={said}
            title={said}
          />
        ))}
      {props.children}
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
 * saved, nor more than `MOST_HEADERS`. A cell that is not right is marked, and says why on hovering
 * it. Headers are kept as secret as the key, so one that holds a key is taken as it is.
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
            title={problems[index] === "name" ? t("ai.headers.problem.name") : undefined}
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
            title={problems[index] === "value" ? t("ai.headers.problem.value") : undefined}
            onChange={(event) => change(row.key, "value", event.target.value)}
            onBlur={() => commit(rows)}
            onKeyDown={(event) => event.key === "Enter" && commit(rows)}
          />
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t("ai.headers.remove")}
            title={t("ai.headers.remove")}
            disabled={props.disabled}
            onClick={() => {
              const left = rows.filter((each) => each.key !== row.key);
              setRows(left);
              commit(left);
            }}
          >
            <X size={14} aria-hidden />
          </button>
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
        className={`${styles.button} ${styles.addButton}`}
        disabled={props.disabled || rows.length >= MOST_HEADERS}
        onClick={() => {
          setRows((before) => [...before, { key: next.current, name: "", value: "" }]);
          next.current += 1;
        }}
      >
        <Plus size={12} aria-hidden /> {t("ai.headers.add")}
      </button>
    </div>
  );
}

/** Where a row was dragged to: before the row it is over, or after it, by where the pointer is. */
export const dropIndex = (event: DragEvent<HTMLElement>, index: number): number => {
  const box = event.currentTarget.getBoundingClientRect();
  return event.clientY > box.top + box.height / 2 ? index + 1 : index;
};

/** The star of a model: filled on the default one; on the others it makes that one the default. */
export function StarButton(props: {
  readonly service: string;
  readonly model: string;
  readonly name: string;
}) {
  const { ai } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const isDefault =
    snapshot.default?.service === props.service && snapshot.default.model === props.model;
  return (
    <button
      type="button"
      className={styles.starButton}
      aria-pressed={isDefault}
      aria-label={isDefault ? t("ai.isDefault") : t("ai.setDefault")}
      title={isDefault ? t("ai.isDefault") : t("ai.setDefault")}
      disabled={snapshot.held !== undefined}
      onClick={() => ai.setDefault({ service: props.service, model: props.model })}
    >
      {isDefault ? "★" : "☆"}
    </button>
  );
}
