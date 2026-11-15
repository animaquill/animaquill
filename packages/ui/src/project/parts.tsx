import type { TFunction } from "i18next";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import settings from "../settings/Settings.module.css";
import styles from "./Project.module.css";

/**
 * One item of the project properties: its name and what changing it does on the left, how it is
 * set on the right, as the rows of the settings. `id` is what the place of the properties goes to,
 * see `ProjectPlace.item`.
 */
export function Row(props: {
  readonly id: string;
  readonly name: ReactNode;
  readonly help?: ReactNode;
  readonly children?: ReactNode;
  /** What is under the words, such as how it stands now. */
  readonly below?: ReactNode;
  /** Laid out under the words rather than beside them, for what needs the width. */
  readonly wide?: boolean;
}) {
  const label = useId();
  return (
    <div
      className={settings.row}
      data-property={props.id}
      data-wide={props.wide ? "" : undefined}
      role="group"
      aria-labelledby={label}
    >
      <div className={settings.words}>
        <span className={settings.name} id={label}>
          {props.name}
        </span>
        {props.help !== undefined && <span className={settings.help}>{props.help}</span>}
        {props.below}
      </div>
      {props.children !== undefined && <div className={styles.control}>{props.children}</div>}
    </div>
  );
}

/** A group of rows, under its title. */
export function Group(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className={settings.scroll}>
      <h2 className={settings.groupTitle}>{props.title}</h2>
      <div className={settings.rows}>{props.children}</div>
    </div>
  );
}

export function Heading({ children }: { readonly children: ReactNode }) {
  return <h3 className={settings.rowsHeading}>{children}</h3>;
}

/**
 * Text that takes when it loses the focus or on Enter, as the settings do: what does not go in is
 * marked and stays to be put right. Esc takes back what was typed, and only then closes.
 */
export function CommitText(props: {
  readonly label: string;
  readonly value: string;
  /** Whether it went in. */
  readonly onCommit: (value: string) => boolean | Promise<boolean>;
  readonly disabled?: boolean;
  readonly multiline?: boolean;
  readonly placeholder?: string;
  readonly className?: string | undefined;
  readonly width?: number;
}) {
  const [draft, setDraft] = useState(props.value);
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  // What others change comes in, unless people are typing here.
  useEffect(() => {
    if (!focused.current) {
      setDraft(props.value);
      setInvalid(false);
    }
  }, [props.value]);
  const commit = async () => {
    if (draft === props.value) return setInvalid(false);
    setInvalid(!(await props.onCommit(draft)));
  };
  const common = {
    "aria-label": props.label,
    "aria-invalid": invalid || undefined,
    value: draft,
    disabled: props.disabled,
    placeholder: props.placeholder,
    spellCheck: false,
    className: `${styles.text} ${props.className ?? ""}`,
    style: props.width === undefined ? undefined : { width: props.width },
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      void commit();
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape" && draft !== props.value) {
        event.preventDefault();
        setDraft(props.value);
        setInvalid(false);
      } else if (
        event.key === "Enter" &&
        !event.nativeEvent.isComposing &&
        (!props.multiline || event.ctrlKey || event.metaKey)
      ) {
        event.preventDefault();
        void commit();
      }
    },
  };
  return props.multiline ? (
    <textarea {...common} rows={3} onChange={(event) => setDraft(event.target.value)} />
  ) : (
    <input {...common} onChange={(event) => setDraft(event.target.value)} />
  );
}

/** A colour, which takes as soon as it is picked. */
export function ColorPick(props: {
  readonly label: string;
  readonly value: string;
  readonly onPick: (color: string) => void;
  readonly disabled?: boolean;
}) {
  const [shown, setShown] = useState(props.value);
  const [was, setWas] = useState(props.value);
  if (was !== props.value) {
    setWas(props.value);
    setShown(props.value);
  }
  return (
    <input
      type="color"
      className={styles.color}
      aria-label={props.label}
      value={shown.slice(0, 7)}
      disabled={props.disabled}
      onChange={(event) => setShown(event.target.value)}
      onBlur={() => shown !== props.value && props.onPick(shown)}
    />
  );
}

/** A small button, as the settings have. */
export function Small(props: {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly label?: string;
}) {
  return (
    <button
      type="button"
      className={settings.button}
      data-danger={props.danger ? "" : undefined}
      disabled={props.disabled}
      aria-label={props.label}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/** A part to read: words beside a value, one line each. */
export function Facts({ items }: { readonly items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className={styles.facts}>
      {items.map(([name, value]) => (
        <div key={name} className={styles.fact}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const when = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });

/** A moment as people read it, or a dash where it is not known. */
export const moment = (at: number | undefined): string =>
  at === undefined ? "—" : when.format(new Date(at));

/** Seconds as the properties show a length: 2:14 or 1:02:14, and tenths below a minute. */
export function length(t: TFunction, seconds: number): string {
  if (seconds < 60) return t("projectProps.seconds", { value: Math.round(seconds * 10) / 10 });
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}
