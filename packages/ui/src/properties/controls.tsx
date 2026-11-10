import { componentSpecOf, componentsOf, nameKeyOf, withComponent } from "@animaquill/core";
import type { Value, ValueType } from "@animaquill/schema";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Tip } from "../app/Tip.tsx";
import type { PropertyRow } from "./inspect.ts";
import { partNameOf, textOf } from "./names.ts";
import { NumberField } from "./NumberField.tsx";
import styles from "./PropertiesPanel.module.css";

/** What a kind of value shows up as. All of them can read and write, none knows about a path. */
export interface ControlProps {
  readonly row: PropertyRow;
  readonly label: string;
  readonly readOnly: boolean;
  readonly onPreview: (value: Value) => void;
  readonly onCommit: (value: Value) => void;
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
          {textOf(t, `property.choice.${nameKeyOf(spec.path)}.${option}`, option)}
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

/** What the picker of the browser gives, with how much the color showed through before. */
const withAlphaOf = (rgb: string, alpha: string) => `${rgb}${alpha}`;

/**
 * A color, picked with what the browser has for that. The picker only knows colors that show
 * through not at all, so how much a color shows through stays as it was. Picking shows right away,
 * and becomes one step when the picker says it is done.
 */
function ColorControl({ row, label, readOnly, onPreview, onCommit }: ControlProps) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const value = typeof row.value === "string" ? row.value.toLowerCase() : undefined;
  const alpha = value?.length === 9 ? value.slice(7) : "";
  const commit = useRef(onCommit);
  useLayoutEffect(() => {
    commit.current = onCommit;
  });
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const done = () => commit.current(withAlphaOf(element.value, element.dataset.alpha ?? ""));
    element.addEventListener("change", done);
    return () => element.removeEventListener("change", done);
  }, []);
  return (
    <span className={styles.color} data-tried={row.tried || undefined}>
      <input
        ref={input}
        type="color"
        className={styles.swatch}
        aria-label={label}
        disabled={readOnly}
        data-alpha={alpha}
        value={value?.slice(0, 7) ?? "#000000"}
        // React calls every move of the picker a change. The real one comes from `useEffect`.
        onChange={(event) => onPreview(withAlphaOf(event.target.value, alpha))}
      />
      <span className={styles.colorText} title={value}>
        {value ?? t("property.automatic")}
      </span>
    </span>
  );
}

/**
 * A vector is one value with a number for each of its parts, so changing one part writes all of
 * them, with the others as they are. The parts are called as in the keyframe editor, and they are
 * numbers in the units of the vector there too.
 */
function VectorControl({ row, label, readOnly, onPreview, onCommit, onCancel }: ControlProps) {
  const { t } = useTranslation();
  const { spec } = row;
  const values = Array.isArray(row.value) ? row.value : [];
  const withPart = (index: number, part: number) => withComponent(values, index, part);
  const partSpec = componentSpecOf(spec);
  return (
    <span className={styles.vector}>
      {componentsOf(spec).map((name, index) => (
        <NumberField
          key={name}
          label={`${label} ${partNameOf(name)}`}
          spec={partSpec}
          value={values[index] ?? 0}
          automatic={row.automatic}
          placeholder={t("property.automatic")}
          animated={row.animated}
          tried={row.tried}
          readOnly={readOnly || values.length <= index}
          onPreview={(part) => onPreview(withPart(index, part))}
          onCommit={(part) => onCommit(withPart(index, part))}
          onCancel={onCancel}
        />
      ))}
    </span>
  );
}

/** A list of any length only says how long it is. Code has numbers in there, not people. */
function NumbersValue({ row }: ControlProps) {
  const { t } = useTranslation();
  const count = Array.isArray(row.value) ? row.value.length : 0;
  return <span className={styles.plain}>{t("property.numbers", { count })}</span>;
}

/** A value as words: references by what they point at, lists by their numbers. */
function plainText(value: Value): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value !== "object") return String(value);
  if ("asset" in value) return value.asset;
  return "string" in value ? value.string : value.path;
}

export function PlainValue({ row, format }: ControlProps) {
  const text = row.value === undefined ? "" : format ? format(row.value) : plainText(row.value);
  return (
    <span className={styles.plain} title={text}>
      {text}
    </span>
  );
}

/**
 * Words, which become one step when people are done with them: Enter, or leaving the field. Escape
 * goes back to what was there. Words from the string tables only show here.
 */
function TextControl(props: ControlProps) {
  const { row, label, readOnly, onCommit } = props;
  const [typed, setTyped] = useState<string | undefined>(undefined);
  // What is typed right now, for the moment the field is left: state only has it after a render.
  const typing = useRef<string | undefined>(undefined);
  const { value } = row;
  if (value !== undefined && typeof value !== "string") return <PlainValue {...props} />;
  const type = (text: string | undefined) => {
    typing.current = text;
    setTyped(text);
  };
  return (
    <input
      type="text"
      className={styles.text}
      aria-label={label}
      readOnly={readOnly}
      data-tried={row.tried || undefined}
      value={typed ?? value ?? ""}
      onChange={(event) => type(event.target.value)}
      onBlur={() => {
        const text = typing.current;
        type(undefined);
        if (text !== undefined && text !== (value ?? "")) onCommit(text);
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape") {
          event.stopPropagation();
          type(undefined);
        } else if (event.key !== "Enter") return;
        event.currentTarget.blur();
      }}
    />
  );
}

/** A value is shown by its type, so a new property needs no new control. */
export const CONTROLS: Partial<Record<ValueType, ComponentType<ControlProps>>> = {
  number: NumberControl,
  angle: NumberControl,
  choice: ChoiceControl,
  boolean: BooleanControl,
  text: TextControl,
  color: ColorControl,
  vec2: VectorControl,
  vec3: VectorControl,
  vec4: VectorControl,
  numbers: NumbersValue,
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
