import { projectFrameRate, type BeforeAfter, type Origin } from "@animaquill/core";
import { formatAddress } from "@animaquill/tools";
import { ToggleLeft, ToggleRight, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { Tip } from "../app/Tip.tsx";
import { describeFailure } from "../export/words.ts";
import { formatTimecode, frameAt, frameRate, type FrameRate } from "../timeline/frames.ts";
import { fieldName } from "./change-line.ts";
import { changePicturesOf, type ShownPicture, type ShownPictures } from "./change-pictures.ts";
import {
  detailOf,
  hasKeys,
  keysChart,
  keysOf,
  shapeOf,
  type ChangeDetail,
  type CodeDetail,
  type FieldDetail,
  type PictureAt,
  valueOf,
} from "./change-detail.ts";
import { diffLines, hunksOf, type DiffHunk } from "./line-diff.ts";
import type { TurnChange } from "./summary.ts";
import styles from "./ChatPanel.module.css";

/** How many lines of code the card shows before “all”. */
const SHOWN_LINES = 40;
/** The long side of the pictures before and after, in pixels. */
const PICTURE_SIDE = 320;

/**
 * One line of the card of a task, opened (S-D1): what it changed before and after, from the undo
 * log of the task on this device. The card asks `detailOf` first and only offers to open a line
 * that has something to show here.
 */
export function ChangeDetailView({
  origin,
  change,
  detail,
  seen,
}: {
  readonly origin: Origin;
  readonly change: TurnChange;
  readonly detail: ChangeDetail;
  readonly seen: BeforeAfter;
}) {
  const { store } = useSession();
  const state = useProject(store);
  const rate = useMemo(() => frameRate(state ? projectFrameRate(state.manifest) : "30"), [state]);
  return (
    <div className={styles.detail} data-testid="chat-change-detail">
      {detail.fields.map((field) =>
        hasKeys(field) ? (
          <KeysRow key={field.path} field={field} detail={detail} rate={rate} />
        ) : (
          <FieldRow key={field.path} field={field} rate={rate} />
        ),
      )}
      {detail.code && <CodeDiff origin={origin} code={detail.code} />}
      {detail.picture && (
        <Pictures origin={origin} change={change} at={detail.picture} seen={seen} />
      )}
    </div>
  );
}

/** Works out what a line shows, or undefined: see `detailOf`. */
export function useDetail(
  origin: Origin,
  change: TurnChange,
  wanted: boolean,
): { readonly detail: ChangeDetail; readonly seen: BeforeAfter } | undefined {
  const workbench = useWorkbench();
  const { store } = useSession();
  // What it shows follows the project: the rest of it is as it is now.
  const state = useProject(wanted ? store : undefined);
  const shown = workbench.timeline.model?.id;
  return useMemo(() => {
    if (!wanted || !store || !state) return undefined;
    const seen = store.beforeAfterOf(origin);
    const detail = seen && detailOf(change, seen, shown);
    return seen && detail ? { detail, seen } : undefined;
  }, [wanted, store, state, origin, change, shown]);
}

function timeText(seconds: number, rate: FrameRate): string {
  return formatTimecode(frameAt(seconds, rate), rate);
}

/** A value as the properties panel shows it: a time, a color, a switch, a number or text. */
function ValueView({ path, value, rate }: { path: string; value: unknown; rate: FrameRate }) {
  const { t } = useTranslation();
  const shape = shapeOf(path, value);
  switch (shape.kind) {
    case "none":
      return <span className={styles.valueNone}>—</span>;
    case "time":
      return <span className={styles.value}>{timeText(shape.seconds, rate)}</span>;
    case "color":
      return (
        <span className={styles.value} title={shape.color}>
          <span className={styles.swatch} style={{ background: shape.color }} aria-hidden="true" />
          {shape.color}
        </span>
      );
    case "boolean":
      return shape.on ? (
        <ToggleRight size={16} className={styles.switchOn} aria-label={t("chat.beforeAfter.on")} />
      ) : (
        <ToggleLeft size={16} className={styles.switchOff} aria-label={t("chat.beforeAfter.off")} />
      );
    case "text":
      return (
        <span className={styles.value} title={shape.text}>
          {shape.text}
        </span>
      );
  }
}

function FieldRow({ field, rate }: { field: FieldDetail; rate: FrameRate }) {
  const { t } = useTranslation();
  return (
    <div className={styles.baField} data-field={field.path}>
      <span className={styles.fieldName}>{fieldName(t, field.path)}</span>
      <span className={styles.fieldValues}>
        <ValueView path={field.path} value={field.before} rate={rate} />
        <span className={styles.arrow} aria-hidden="true">
          →
        </span>
        <ValueView path={field.path} value={field.after} rate={rate} />
      </span>
    </div>
  );
}

/**
 * Keys before and after: numbers as two curves over the clock of the clip, the one before grey and
 * dashed; anything else as its keys, before against after.
 */
function KeysRow({
  field,
  detail,
  rate,
}: {
  field: FieldDetail;
  detail: ChangeDetail;
  rate: FrameRate;
}) {
  const { t } = useTranslation();
  const name = fieldName(t, field.path);
  const chart = keysChart(field, detail.clock);
  return (
    <div className={styles.keys} data-field={field.path}>
      <span className={styles.fieldName}>{name}</span>
      {chart ? (
        <svg
          className={styles.chart}
          viewBox={`0 0 ${chart.width} ${chart.height}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={name}
        >
          {chart.lines.map((line, index) => (
            <polyline
              key={index}
              points={line.points}
              className={line.side === "before" ? styles.curveBefore : styles.curveAfter}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {chart.dots.map((dot, index) => (
            <circle
              key={index}
              cx={dot.x}
              cy={dot.y}
              r={2.5}
              className={dot.side === "before" ? styles.dotBefore : styles.dotAfter}
            />
          ))}
        </svg>
      ) : (
        <div className={styles.keyLists}>
          <KeyList path={field.path} value={field.before} rate={rate} />
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
          <KeyList path={field.path} value={field.after} rate={rate} />
        </div>
      )}
    </div>
  );
}

function KeyList({ path, value, rate }: { path: string; value: unknown; rate: FrameRate }) {
  const keys = keysOf(valueOf(path, value));
  if (keys.length === 0) return <span className={styles.valueNone}>—</span>;
  return (
    <ul className={styles.keyList}>
      {keys.map((key, index) => (
        <li key={index}>
          {key.time !== undefined && (
            <span className={styles.keyTime}>{timeText(key.time, rate)}</span>
          )}
          <ValueView path={path} value={key.value} rate={rate} />
        </li>
      ))}
    </ul>
  );
}

/** The lines that changed, two around each; all of them in the code editor, side by side. */
function CodeDiff({ origin, code }: { origin: Origin; code: CodeDetail }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const { path, before = "", after = "", large } = code;
  const hunks = useMemo(
    () => (large ? [] : hunksOf(diffLines(before, after))),
    [large, before, after],
  );
  const total = hunks.reduce((sum, hunk) => sum + hunk.length, 0);
  // Up to `SHOWN_LINES` of them, cut where that is reached.
  const shown = all
    ? hunks
    : hunks.reduce<{ hunks: DiffHunk[]; left: number }>(
        (kept, hunk) => {
          if (kept.left <= 0) return kept;
          const part = hunk.slice(0, kept.left);
          return { hunks: [...kept.hunks, part], left: kept.left - part.length };
        },
        { hunks: [], left: SHOWN_LINES },
      ).hunks;
  return (
    <div className={styles.code}>
      {shown.length > 0 && (
        <div className={styles.codeLines} data-testid="chat-change-code">
          {shown.map((hunk, index) => (
            <div key={index} className={styles.hunk}>
              {hunk.map((line, at) => (
                <div key={at} className={styles.codeLine} data-kind={line.kind}>
                  <span className={styles.lineNumber}>{line.after ?? line.before}</span>
                  <span className={styles.lineText}>{line.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className={styles.codeActions}>
        {total > SHOWN_LINES && !all && (
          <button type="button" className={styles.link} onClick={() => setAll(true)}>
            {t("chat.beforeAfter.all")}
          </button>
        )}
        <button
          type="button"
          className={styles.link}
          onClick={() => workbench.compareCode(`compare:${origin}:${path}`, path, before, after)}
        >
          {t("chat.beforeAfter.openCompare")}
        </button>
      </div>
    </div>
  );
}

/**
 * The picture before and after at one moment, rendered when the line opens, as it was then: the
 * project changing afterwards does not render them again until the line opens again. Each goes to
 * that moment on the timeline.
 */
function Pictures({
  origin,
  change,
  at,
  seen,
}: {
  origin: Origin;
  change: TurnChange;
  at: PictureAt;
  seen: BeforeAfter;
}) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const state = useProject(store);
  const [key] = useState(
    () => `${origin}\n${change.key}\n${at.timeline}\n${at.seconds}\n${store?.revisionId ?? ""}`,
  );
  const [request] = useState(() => ({ ...seen, ...at, side: PICTURE_SIDE }));
  const [shown, setShown] = useState<ShownPictures>();
  useEffect(() => {
    let live = true;
    void changePicturesOf(workbench.looks)
      .get(key, () => request)
      .then((pictures) => {
        if (live) setShown(pictures);
      });
    return () => {
      live = false;
    };
  }, [workbench, key, request]);
  const format = state?.manifest.formats[0];
  const box: CSSProperties = {
    aspectRatio: format ? `${format.width} / ${format.height}` : "16 / 9",
  };
  const go = () =>
    workbench.goToRef(
      formatAddress({
        kind: "time",
        timeline: at.timeline,
        t: String(Math.round(at.seconds * 1000) / 1000),
      }),
    );
  const why = (picture: ShownPicture | undefined) =>
    picture && !picture.ok && state
      ? describeFailure(t, picture.failure, state, workbench.timeline)
      : undefined;
  return (
    <div className={styles.baPictures} data-testid="chat-change-pictures">
      {(["before", "after"] as const).map((side) => {
        const picture = shown?.[side];
        const reason = why(picture);
        const button = (
          <button
            type="button"
            className={styles.baPicture}
            style={box}
            data-state={picture ? (picture.ok ? "ready" : "failed") : "rendering"}
            aria-label={t(`chat.beforeAfter.${side}`)}
            onClick={go}
          >
            {picture?.ok && <img src={picture.url} alt="" />}
            {reason !== undefined && <TriangleAlert size={16} aria-hidden="true" />}
          </button>
        );
        return (
          <figure key={side} className={styles.baPictureSide}>
            {reason === undefined ? (
              button
            ) : (
              <Tip name={reason} usage="">
                {button}
              </Tip>
            )}
            <figcaption>{t(`chat.beforeAfter.${side}`)}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}
