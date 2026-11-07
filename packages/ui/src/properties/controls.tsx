import type { ValueType } from "@animaquill/schema";
import type { ComponentType, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Tip } from "../app/Tip.tsx";
import type { PropertyRow } from "./inspect.ts";
import { textOf } from "./names.ts";
import { NumberField } from "./NumberField.tsx";
import styles from "./PropertiesPanel.module.css";

/** What a kind of value shows up as. All of them can read and write, none knows about a path. */
export interface ControlProps {
  readonly row: PropertyRow;
  readonly label: string;
  readonly readOnly: boolean;
  readonly onPreview: (value: number) => void;
  readonly onCommit: (value: number | string | boolean) => void;
  readonly onCancel: () => void;
  /** How a value without a control of its own reads, where that is said somewhere else as well. */
  readonly format?: (value: unknown) => string;
}

function NumberControl({ row, label, readOnly, onPreview, onCommit, onCancel }: ControlProps) {
  const { t } = useTranslation();
  return (
    <NumberField
      label={label}
      spec={row.spec}
      value={typeof row.value === "number" ? row.value : 0}
      automatic={row.automatic}
      placeholder={t("property.automatic")}
      animated={row.animated}
      tried={row.tried}
      readOnly={readOnly}
      onPreview={onPreview}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
}

function ChoiceControl({ row, label, readOnly, onCommit }: ControlProps) {
  const { t } = useTranslation();
  const { spec, value } = row;
  return (
    <select
      className={styles.choice}
      aria-label={label}
      disabled={readOnly}
      data-tried={row.tried || undefined}
      value={String(value)}
      onChange={(event) => onCommit(event.target.value)}
    >
      {spec.options?.map((option) => (
        <option key={option} value={option}>
          {textOf(t, `property.choice.${spec.path}.${option}`, option)}
        </option>
      ))}
    </select>
  );
}

/** A switch goes the other way with a click. With keys that is a key at the playhead. */
function BooleanControl({ row, label, readOnly, onCommit }: ControlProps) {
  const { t } = useTranslation();
  const on = row.value === true;
  return (
    <button
      type="button"
      role="switch"
      className={styles.switch}
      aria-label={label}
      aria-checked={on}
      disabled={readOnly}
      data-tried={row.tried || undefined}
      onClick={() => onCommit(!on)}
    >
      {t(on ? "property.on" : "property.off")}
    </button>
  );
}

export function PlainValue({ row, format }: ControlProps) {
  const text = row.value === undefined ? "" : format ? format(row.value) : String(row.value);
  return <span className={styles.plain}>{text}</span>;
}

/** A value is shown by its type, so a new property needs no new control. */
export const CONTROLS: Partial<Record<ValueType, ComponentType<ControlProps>>> = {
  number: NumberControl,
  angle: NumberControl,
  choice: ChoiceControl,
  boolean: BooleanControl,
};

interface RowButtonProps {
  readonly name: string;
  readonly usage: string;
  readonly unavailable: boolean;
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

export function RowButton({
  name,
  usage,
  unavailable,
  pressed,
  onClick,
  children,
}: RowButtonProps) {
  return (
    <Tip name={name} usage={usage}>
      <button
        type="button"
        className={styles.rowButton}
        aria-label={name}
        // Not `disabled`: a disabled button gets no mouse events, and it still has to explain itself.
        {...(unavailable ? { "aria-disabled": true } : {})}
        {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
        onClick={() => {
          if (!unavailable) onClick();
        }}
      >
        {children}
      </button>
    </Tip>
  );
}
