import { SCENE_OBJECT_TYPES, type PropertyEdit } from "@animaquill/core";
import type { ObjectDescriptor } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { ChevronLeft, ChevronRight, Diamond, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { PopupMenu } from "../app/Menu.tsx";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { CONTROLS, PlainValue, RowButton } from "./controls.tsx";
import {
  inspect,
  keyEdit,
  writeEdit,
  type Blocked,
  type Inspection,
  type PropertyRow,
} from "./inspect.ts";
import { groupOf, nameOf, textOf } from "./names.ts";
import styles from "./PropertiesPanel.module.css";

type ClipInspection = Extract<Inspection, { kind: "clip" }>;

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

/** A sound that code makes says how that is going, and one that failed can try again. */
function SoundStatus({ clip }: { clip: ClipInspection["box"]["clip"] }) {
  const { sounds } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(sounds.subscribe, sounds.getVersion);
  const sound = sounds.stateOf(clip);
  if (!sound || sound.state === "ready") return null;
  return (
    <div className={styles.hint} role="status">
      <span>{t(`sound.state.${sound.state}`)}</span>
      {sound.state === "failed" && (
        <button type="button" className={styles.hintButton} onClick={() => sounds.retry(clip)}>
          {t("sound.retry")}
        </button>
      )}
    </div>
  );
}

/** What an object of a clip is called by itself, unless it is the clip itself. */
function ownName(t: TFunction, { type, name, id }: ObjectDescriptor): string | undefined {
  if (type === "clip.visual" || type === "clip.sound") return undefined;
  if (type === SCENE_OBJECT_TYPES.params) return t("keyframes.objects.params");
  if (type === SCENE_OBJECT_TYPES.elements) return t("keyframes.objects.elements");
  return name ?? id;
}

/** Objects can be inside each other, which a flat list says with the names of what they are in. */
const MAX_NAMED_PARENTS = 4;

function objectName(
  t: TFunction,
  object: ObjectDescriptor,
  byId: ReadonlyMap<string, ObjectDescriptor>,
): string | undefined {
  const own = ownName(t, object);
  if (own === undefined) return undefined;
  const names = [own];
  const seen = new Set([object.id]);
  let parent = object.parent === undefined ? undefined : byId.get(object.parent);
  while (parent && !seen.has(parent.id) && names.length <= MAX_NAMED_PARENTS) {
    seen.add(parent.id);
    names.unshift(ownName(t, parent) ?? parent.id);
    parent = parent.parent === undefined ? undefined : byId.get(parent.parent);
  }
  return names.join(" › ");
}

function ClipProperties({ inspection }: { inspection: ClipInspection }) {
  const { t } = useTranslation();
  const { box, blocked, objects, firstFrame } = inspection;
  const byId = new Map(objects.map(({ object }) => [object.id, object]));
  const { kind } = box.clip.source;
  const kindName = textOf(t, `timeline.kind.${kind}`, kind);
  return (
    <>
      <header className={styles.header}>
        <span className={styles.title}>{box.clip.name ?? kindName}</span>
        {box.clip.name !== undefined && <span className={styles.kind}>{kindName}</span>}
      </header>
      {kind === "sound" && <SoundStatus clip={box.clip} />}
      {blocked && <BlockedHint blocked={blocked} firstFrame={firstFrame} />}
      <div className={styles.rows} data-readonly={blocked !== undefined || undefined}>
        {objects.map(({ object, rows }) => {
          if (rows.length === 0) return null;
          const name = objectName(t, object, byId);
          return (
            // Another clip gets fields of its own, so nothing typed can end up on the wrong one.
            <section
              key={`${box.id} ${object.id}`}
              className={styles.object}
              {...(name !== undefined && { "aria-label": name })}
            >
              {name !== undefined && <h3 className={styles.objectName}>{name}</h3>}
              {rows.map((row, index) => (
                <Row
                  key={row.path}
                  inspection={inspection}
                  row={row}
                  startsGroup={rows[index - 1]?.spec.group !== row.spec.group}
                />
              ))}
            </section>
          );
        })}
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
  const { timeline, trials, keyframes, registrations } = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const { model, selection } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const frame = useSyncExternalStore(timeline.subscribeView, () => timeline.frame);
  const { comparing } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);
  // What scenes registered changes what their clips have to show.
  useSyncExternalStore(registrations.subscribe, registrations.getVersion);
  const { describe } = keyframes;
  const inspection: Inspection =
    state && model
      ? inspect(state, model, selection, frame, { look: trials.look, comparing, describe })
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
