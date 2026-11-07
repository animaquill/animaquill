import type { PropertyEdit } from "@animaquill/core";
import { ChevronLeft, ChevronRight, Diamond, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { TFunction } from "i18next";
import type { PropertySpec, ValueType } from "@animaquill/schema";
import { useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu } from "../app/Menu.tsx";
import { Tip } from "../app/Tip.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import {
  inspect,
  keyEdit,
  writeEdit,
  type Blocked,
  type Inspection,
  type PropertyRow,
} from "./inspect.ts";
import { NumberField } from "./NumberField.tsx";
import styles from "./PropertiesPanel.module.css";

type ClipInspection = Extract<Inspection, { kind: "clip" }>;

/** Built-in properties find their names by path. What comes from a project brings its own. */
const textOf = (t: TFunction, key: string, fallback: string): string =>
  (t as unknown as (key: string, options: { defaultValue: string }) => string)(key, {
    defaultValue: fallback,
  });

const nameOf = (t: TFunction, spec: PropertySpec) =>
  spec.name ?? textOf(t, `property.name.${spec.path}`, spec.path);

const groupOf = (t: TFunction, group: string) => textOf(t, `property.group.${group}`, group);

/** What a kind of value shows up as. All of them can read and write, none knows about a path. */
interface ControlProps {
  readonly row: PropertyRow;
  readonly label: string;
  readonly readOnly: boolean;
  readonly onPreview: (value: number) => void;
  readonly onCommit: (value: number | string) => void;
  readonly onCancel: () => void;
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

function PlainValue({ row }: ControlProps) {
  return <span className={styles.plain}>{String(row.value ?? "")}</span>;
}

/** A value is shown by its type, so a new property needs no new control. */
const CONTROLS: Partial<Record<ValueType, ComponentType<ControlProps>>> = {
  number: NumberControl,
  angle: NumberControl,
  choice: ChoiceControl,
};

interface RowButtonProps {
  readonly name: string;
  readonly usage: string;
  readonly unavailable: boolean;
  readonly pressed?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function RowButton({ name, usage, unavailable, pressed, onClick, children }: RowButtonProps) {
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

interface RowProps {
  readonly inspection: ClipInspection;
  readonly row: PropertyRow;
  /** The first of a group says what the group is. */
  readonly startsGroup: boolean;
}

function Row({ inspection, row, startsGroup }: RowProps) {
  const { properties, timeline, trials } = useWorkbench();
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number }>();
  const { spec, path, animated, keyTime, previousKey, nextKey, stored, tried } = row;
  const { box, blocked, time } = inspection;
  const name = nameOf(t, spec);
  const { group } = spec;
  const label = group === undefined ? name : `${groupOf(t, group)} ${name}`;
  const readOnly = blocked !== undefined;
  const Control = CONTROLS[spec.type] ?? PlainValue;
  const onKey = keyTime !== undefined;
  const key = keyEdit(box.id, row, time);
  const reset: PropertyEdit = { owner: { clip: box.id }, path, op: "clear" };

  return (
    <>
      <div
        className={styles.row}
        role="group"
        aria-label={label}
        data-tried={tried || undefined}
        onContextMenu={(event) => {
          if (!tried) return;
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {group === undefined ? (
          <span className={styles.name}>{name}</span>
        ) : (
          <>
            <span className={styles.group}>{startsGroup ? groupOf(t, group) : ""}</span>
            <span className={styles.part}>{name}</span>
          </>
        )}
        <Control
          row={row}
          label={label}
          readOnly={readOnly}
          onPreview={(number) => properties.preview([writeEdit(box.id, row, time, number)])}
          // The playhead can leave the clip while a value is still in somebody's hands.
          onCommit={(number) => {
            if (readOnly) properties.cancel();
            else properties.commit([writeEdit(box.id, row, time, number)]);
          }}
          onCancel={() => properties.cancel()}
        />
        <div className={styles.rowButtons}>
          {spec.animatable !== false && (
            <>
              <RowButton
                name={t("property.previousKey")}
                usage={t("property.help.previousKey")}
                unavailable={previousKey === undefined}
                onClick={() => timeline.seek(previousKey as number)}
              >
                <ChevronLeft size={13} />
              </RowButton>
              <RowButton
                name={onKey ? t("property.removeKey") : t("property.addKey")}
                usage={animated ? t("property.help.key") : t("property.help.firstKey")}
                unavailable={readOnly || key === undefined}
                pressed={onKey}
                onClick={() => {
                  if (key) properties.commit([key]);
                }}
              >
                <Diamond
                  size={12}
                  className={animated ? styles.keyed : undefined}
                  {...(onKey ? { fill: "currentColor" } : {})}
                />
              </RowButton>
              <RowButton
                name={t("property.nextKey")}
                usage={t("property.help.nextKey")}
                unavailable={nextKey === undefined}
                onClick={() => timeline.seek(nextKey as number)}
              >
                <ChevronRight size={13} />
              </RowButton>
            </>
          )}
          <RowButton
            name={t("property.reset")}
            usage={t("property.help.reset")}
            unavailable={readOnly || stored === undefined}
            onClick={() => properties.commit([reset])}
          >
            <RotateCcw size={12} />
          </RowButton>
        </div>
      </div>
      {row.changedElsewhere && <p className={styles.elsewhere}>{t("trial.changedElsewhere")}</p>}
      {menu && (
        <PopupMenu
          label={label}
          x={menu.x}
          y={menu.y}
          groups={[
            [
              {
                id: "discard",
                label: t("trial.discardProperty"),
                run: () => trials.discardProperty(box.id, path),
              },
            ],
          ]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </>
  );
}

/** Says why the controls do not react, and how to change that when something can be done. */
function BlockedHint({ blocked, firstFrame }: { blocked: Blocked; firstFrame: number }) {
  const { timeline, trials } = useWorkbench();
  const { t } = useTranslation();
  return (
    <div className={styles.hint} role="status">
      <span>{t(`property.blocked.${blocked}`)}</span>
      {blocked === "outside" && (
        <button
          type="button"
          className={styles.hintButton}
          onClick={() => timeline.seek(firstFrame)}
        >
          {t("property.goToClip")}
        </button>
      )}
      {blocked === "comparing" && (
        <button type="button" className={styles.hintButton} onClick={() => trials.toggleCompare()}>
          {t("trial.backToTrial")}
        </button>
      )}
    </div>
  );
}

function ClipProperties({ inspection }: { inspection: ClipInspection }) {
  const { t } = useTranslation();
  const { box, blocked, objects, firstFrame } = inspection;
  const { kind } = box.clip.source;
  const kindName = textOf(t, `timeline.kind.${kind}`, kind);
  return (
    <>
      <header className={styles.header}>
        <span className={styles.title}>{box.clip.name ?? kindName}</span>
        {box.clip.name !== undefined && <span className={styles.kind}>{kindName}</span>}
      </header>
      {blocked && <BlockedHint blocked={blocked} firstFrame={firstFrame} />}
      <div className={styles.rows} data-readonly={blocked !== undefined || undefined}>
        {objects.map(({ object, rows }) => (
          // Another clip gets fields of its own, so nothing typed can end up on the wrong one.
          <section key={`${box.id} ${object.id}`} className={styles.object}>
            {rows.map((row, index) => (
              <Row
                key={row.path}
                inspection={inspection}
                row={row}
                startsGroup={rows[index - 1]?.spec.group !== row.spec.group}
              />
            ))}
          </section>
        ))}
      </div>
    </>
  );
}

function Message({ text }: { text: string }) {
  return (
    <div className={styles.message}>
      <SlidersHorizontal size={32} />
      <p>{text}</p>
    </div>
  );
}

export function PropertiesPanel() {
  const { timeline, trials } = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const { model, selection } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const frame = useSyncExternalStore(timeline.subscribeView, () => timeline.frame);
  const { comparing } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);
  const inspection: Inspection =
    state && model
      ? inspect(state, model, selection, frame, { look: trials.look, comparing })
      : { kind: "nothing" };

  return (
    // Focusable, so that the keyboard has somewhere to go after a field, without a frame around it.
    <div className={styles.panel} tabIndex={-1}>
      {inspection.kind === "nothing" && <Message text={t("property.nothing")} />}
      {inspection.kind === "no-properties" && <Message text={t("property.noProperties")} />}
      {inspection.kind === "several" && (
        <Message text={t("property.several", { count: inspection.count })} />
      )}
      {inspection.kind === "clip" && <ClipProperties inspection={inspection} />}
    </div>
  );
}
