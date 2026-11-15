import type { ToolCallEntry, ToolEntry, ToolPicture } from "@animaquill/agent";
import type { LookData, LookFinding, LookShotData } from "@animaquill/tools";
import { Check, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { usePictureUrl } from "./AttachmentsView.tsx";
import styles from "./ChatPanel.module.css";
import { useNow } from "./clock.ts";
import { useOpened } from "./expanded.ts";
import { timeText, toolErrorCode, type Names, type Say } from "./toolSummary.ts";
import { durationText } from "./turns.ts";

/**
 * AI looked at the picture (mcp.md 8, 6.11a): unlike other calls, its row shows the pictures right
 * under it, each with its time and the boxes AI asked for, and a line of what the list it read
 * found. A click shows one large, with and without its boxes, and moves the playhead there. A
 * comparison shows before, after and what differs; a part shown large, where it is on the picture;
 * an overview, its one picture. Where the frame could not be rendered the row is red and says why,
 * as AI was told.
 */

/** A call quicker than this says nothing of how long it took. */
const SHOWN_MS = 100;
/** At most this many findings in the line under the pictures. */
const FINDINGS = 3;

export const lookOf = (result: ToolEntry | undefined): LookData | undefined => {
  const look = result?.data?.look;
  return typeof look === "object" && look !== null ? (look as LookData) : undefined;
};

/** Where a box is on the picture, in thirds: 左上角 to 右下角, or all of it. */
export function whereOf(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  stage: { readonly width: number; readonly height: number },
): string {
  if (box.width >= stage.width * 0.66 && box.height >= stage.height * 0.66) return "whole";
  const third = (at: number, size: number) => {
    const share = (at + size / 2) / size;
    return share < 1 / 3 ? 0 : share < 2 / 3 ? 1 : 2;
  };
  const column = third(box.x + box.width / 2, stage.width);
  const row = third(box.y + box.height / 2, stage.height);
  return [
    "topLeft",
    "top",
    "topRight",
    "left",
    "middle",
    "right",
    "bottomLeft",
    "bottom",
    "bottomRight",
  ][row * 3 + column] as string;
}

const percentText = (ratio: number) =>
  ratio > 0 && ratio < 0.001 ? "<0.1%" : `${Math.round(ratio * 1000) / 10}%`;

const tokenText = (count: number) =>
  count >= 1000 ? `${Math.round(count / 100) / 10}k` : String(count);

/** One finding as people read it. */
function findingText(say: Say, finding: LookFinding): string {
  switch (finding.kind) {
    case "past":
      return say("chat.look.finding.past", {
        name: finding.name ?? finding.id,
        side: say(`chat.look.side.${finding.side}`),
        by: finding.by,
      });
    case "text-past":
      return say("chat.look.finding.textPast", {
        text: finding.text,
        side: say(`chat.look.side.${finding.side}`),
        by: finding.by,
      });
    case "outside":
      return say("chat.look.finding.outside", { name: finding.name ?? finding.id });
    case "overlap":
      return say("chat.look.finding.overlap", {
        name: finding.name ?? finding.id,
        other: finding.otherName ?? finding.other,
      });
  }
}

/**
 * The findings of all frames, each once, with the times it was found at where there are several:
 * 「标题」右边超出画面 32 像素（0:12–0:16）.
 */
export function findingsLine(say: Say, look: LookData): string {
  const found = new Map<string, number[]>();
  for (const [index, shot] of look.shots.entries()) {
    for (const finding of shot.findings) {
      const text = findingText(say, finding);
      found.set(text, [...(found.get(text) ?? []), index]);
    }
  }
  const parts = [...found].slice(0, FINDINGS).map(([text, at]) => {
    if (look.shots.length < 2 || at.length === look.shots.length) return text;
    const first = look.shots[at[0] as number] as LookShotData;
    const last = look.shots[at.at(-1) as number] as LookShotData;
    const when = at.length === 1 ? timeText(first.t) : `${timeText(first.t)}–${timeText(last.t)}`;
    return `${text}（${when}）`;
  });
  const more = found.size - FINDINGS;
  return [...parts, ...(more > 0 ? [say("chat.look.moreFindings", { count: more })] : [])].join(
    "；",
  );
}

/** What a look did, in a few words after its name. */
function lookSummary(say: Say, call: ToolCallEntry, look: LookData | undefined): string {
  const args = call.args;
  if (!look) {
    const times = Array.isArray(args.times) ? args.times.map((time) => timeText(time)) : [];
    return times.join("、");
  }
  if (look.failure) {
    const reason = say(`chat.look.why.${look.failure.reason}`, {
      clip: look.failure.clipName ?? ("layer" in look.failure ? look.failure.layer : ""),
      asset: look.failure.assetName ?? say("chat.look.someAsset"),
      defaultValue: say("chat.look.why.failed"),
    });
    return say("chat.look.failed", { time: timeText(look.failure.t), reason });
  }
  if (!look.sees) return say("chat.look.blind");
  const times = look.shots.map(({ t }) => timeText(t) ?? t);
  const cost = say("chat.look.tokens", { count: tokenText(look.tokens) });
  switch (look.kind) {
    case "overview":
      return `${say("chat.look.overview", {
        from: timeText(look.range?.from ?? times[0]),
        to: timeText(look.range?.to ?? times.at(-1)),
        count: look.shots.length,
      })} · ${cost}`;
    case "zoom":
      return `${say("chat.look.zoom", {
        time: times.join("、"),
        where: say(
          `chat.look.where.${whereOf(look.region ?? { x: 0, y: 0, width: 0, height: 0 }, look.stage)}`,
        ),
      })} · ${cost}`;
    case "compare": {
      const changed = look.shots.map(({ changed: what }) => what);
      const most = changed.reduce<LookShotData["changed"]>(
        (best, each) => (each && (!best || each.ratio > best.ratio) ? each : best),
        undefined,
      );
      const what =
        !most || most.ratio === 0
          ? say("chat.look.unchanged")
          : say("chat.look.changed", {
              percent: percentText(most.ratio),
              where: say(`chat.look.where.${most.box ? whereOf(most.box, look.stage) : "whole"}`),
            });
      return `${times.join("、")} · ${what} · ${cost}`;
    }
    default:
      return `${times.join("、")}${say("chat.look.count", { count: times.length })} · ${cost}`;
  }
}

/** The pictures of a look by moment, as they show in a row. */
interface Shot {
  readonly index: number;
  readonly data: LookShotData | undefined;
  /** In order: what AI saw first. */
  readonly pictures: readonly { readonly picture: ToolPicture; readonly label?: string }[];
  readonly clean?: ToolPicture;
}

function shotsOf(say: Say, result: ToolEntry | undefined, look: LookData | undefined): Shot[] {
  const images = result?.images ?? [];
  const count = Math.max(0, ...images.map(({ shot }) => (shot ?? 0) + 1));
  if (look?.kind === "overview") {
    const sheet = images.find(({ role }) => role === "sheet");
    return sheet ? [{ index: 0, data: undefined, pictures: [{ picture: sheet }] }] : [];
  }
  return Array.from({ length: count }, (_, index) => {
    const of = images.filter(({ shot }) => (shot ?? 0) === index);
    const label = (role: string) =>
      role === "before" || role === "after" || role === "diff"
        ? say(`chat.look.${role}`)
        : undefined;
    const clean = of.find(({ role }) => role === "clean");
    return {
      index,
      data: look?.shots[index],
      pictures: of
        .filter(({ role }) => role !== "clean")
        .map((picture) => {
          const named = label(picture.role ?? "");
          return named === undefined ? { picture } : { picture, label: named };
        }),
      ...(clean && { clean }),
    };
  }).filter(({ pictures }) => pictures.length > 0);
}

/** A small picture of a look, with its time, or what it is of a comparison, on it. */
function Thumb({
  picture,
  label,
  look,
  onOpen,
}: {
  readonly picture: ToolPicture;
  readonly label: string | undefined;
  readonly look: LookData;
  readonly onOpen: () => void;
}) {
  const { t } = useTranslation();
  const url = usePictureUrl(picture.image);
  const region = look.kind === "zoom" ? look.region : undefined;
  const wide = picture.role === "sheet";
  return (
    <button
      type="button"
      className={styles.lookThumb}
      data-testid="chat-look-picture"
      data-role={picture.role}
      data-wide={wide ? "" : undefined}
      aria-label={t("chat.look.open")}
      onClick={onOpen}
      style={{ aspectRatio: `${picture.width} / ${picture.height}` }}
    >
      {url && <img src={url} alt={label ?? ""} />}
      {label && <span className={styles.lookTime}>{label}</span>}
      {region && (
        // Where the part shown large is on the picture.
        <svg
          className={styles.lookWhere}
          viewBox={`${-look.stage.width / 2} ${-look.stage.height / 2} ${look.stage.width} ${look.stage.height}`}
          aria-hidden
          data-testid="chat-look-region"
        >
          <rect
            x={-look.stage.width / 2}
            y={-look.stage.height / 2}
            width={look.stage.width}
            height={look.stage.height}
            className={styles.lookWhereFrame}
          />
          <rect
            x={region.x}
            y={region.y}
            width={region.width}
            height={region.height}
            className={styles.lookWhereRegion}
          />
        </svg>
      )}
    </button>
  );
}

export function LookRow({
  call,
  result,
  running,
}: {
  readonly call: ToolCallEntry;
  readonly result: ToolEntry | undefined;
  readonly running: number | undefined;
  readonly names: Names;
}) {
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const failed = result !== undefined && !result.ok;
  const [open, setOpen] = useOpened(call.id, false);
  const [large, setLarge] = useState<number | undefined>();
  const now = useNow(running !== undefined);
  const look = lookOf(result);
  const state =
    result === undefined
      ? running !== undefined
        ? "running"
        : "waiting"
      : failed
        ? "failed"
        : "ok";
  const kind =
    look?.kind ??
    (call.args.compare !== undefined
      ? "compare"
      : call.args.range
        ? "overview"
        : call.args.region
          ? "zoom"
          : "frames");
  const name =
    result === undefined ? say("chat.tool.aq_render_frames") : say(`chat.look.name.${kind}`);
  const code = result && !result.ok && !look?.failure ? toolErrorCode(result) : undefined;
  const summary = code
    ? say(`chat.toolErrors.${code}`, { defaultValue: say("chat.toolErrors.other", { code }), code })
    : lookSummary(say, call, look);
  const shots = shotsOf(say, result, look);
  const ms =
    result?.startedAt !== undefined
      ? result.at - result.startedAt
      : running !== undefined
        ? now - running
        : undefined;
  const findings = look && !look.failure ? findingsLine(say, look) : "";
  // Each moment is a picture people can open, in order: what AI saw of it.
  const flat = shots.flatMap((shot) => shot.pictures.map((each) => ({ ...each, shot })));
  return (
    <div className={styles.tool} data-state={state} data-testid="chat-tool" data-look={kind}>
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
        <span className={styles.toolName}>{name}</span>
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
      {look && flat.length > 0 && (
        <div className={styles.lookStrip} data-testid="chat-look-strip">
          {flat.map(({ picture, label, shot }, at) => (
            <Thumb
              key={picture.image + String(at)}
              picture={picture}
              label={label ?? (shot.data ? timeText(shot.data.t) : undefined)}
              look={look}
              onOpen={() => setLarge(at)}
            />
          ))}
        </div>
      )}
      {findings && (
        <p className={styles.lookFindings} data-testid="chat-look-findings">
          {findings}
        </p>
      )}
      {open && result && (
        <div className={styles.toolBody} data-testid="chat-tool-body">
          <details className={styles.raw} open>
            <summary>{t("chat.look.list")}</summary>
            <pre>{result.text}</pre>
          </details>
        </div>
      )}
      {large !== undefined && look && flat[large] && (
        <LookViewer
          look={look}
          text={result?.text ?? ""}
          items={flat}
          at={large}
          onMove={setLarge}
          onClose={() => setLarge(undefined)}
        />
      )}
    </div>
  );
}

/** A picture AI looked at, large: with or without its boxes, the ones before and after, the playhead there. */
function LookViewer({
  look,
  text,
  items,
  at,
  onMove,
  onClose,
}: {
  readonly look: LookData;
  readonly text: string;
  readonly items: readonly {
    readonly picture: ToolPicture;
    readonly label?: string;
    readonly shot: Shot;
  }[];
  readonly at: number;
  readonly onMove: (at: number) => void;
  readonly onClose: () => void;
}) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const [marks, setMarks] = useState(true);
  const item = items[at] as (typeof items)[number];
  const { shot } = item;
  const clean =
    shot.clean && item.picture.role !== "before" && item.picture.role !== "diff"
      ? shot.clean
      : undefined;
  const shown = !marks && clean ? clean : item.picture;
  const url = usePictureUrl(shown.image);
  const box = useRef<HTMLDivElement>(null);
  // Open, it has the keyboard; closed, it gives it back to where it was.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    return () => before?.focus();
  }, []);
  /** Keys only while it has the focus, and arrows not where they move a caret. */
  const keys = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    const target = event.target as HTMLElement;
    const typing =
      target.isContentEditable ||
      target.tagName === "TEXTAREA" ||
      (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox");
    if (typing) return;
    if (event.key === "ArrowLeft" && at > 0) onMove(at - 1);
    else if (event.key === "ArrowRight" && at < items.length - 1) onMove(at + 1);
  };
  const time = shot.data?.t;
  const timeline = look.timelineName ?? look.timeline;
  const range =
    look.kind === "overview" && look.shots.length > 0
      ? t("chat.look.viewerRange", {
          from: timeText(look.range?.from ?? look.shots[0]?.t),
          to: timeText(look.range?.to ?? look.shots.at(-1)?.t),
        })
      : undefined;
  const where =
    look.kind === "zoom" && look.region
      ? (t as unknown as Say)(`chat.look.where.${whereOf(look.region, look.stage)}`)
      : undefined;
  const title = [
    t("chat.look.viewer"),
    time === undefined ? undefined : `${timeline} ${timeText(time)}`,
    range === undefined ? undefined : `${timeline} ${range}`,
    where,
    item.label,
    `${shown.width}×${shown.height}`,
  ]
    .filter(Boolean)
    .join(" · ");
  return createPortal(
    <div
      className={styles.lookViewer}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="chat-look-large"
      onClick={onClose}
      onKeyDown={keys}
    >
      <div
        ref={box}
        tabIndex={-1}
        className={styles.lookViewerBox}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.lookViewerHead}>
          <span>{title}</span>
          <button
            type="button"
            className={styles.icon}
            aria-label={t("chat.pictures.close")}
            onClick={onClose}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        {url && (
          <img src={url} alt={title} data-testid="chat-look-large-picture" data-role={shown.role} />
        )}
        <div className={styles.lookViewerBar}>
          {clean && (
            <label className={styles.lookToggle}>
              <input
                type="checkbox"
                checked={marks}
                onChange={(event) => setMarks(event.target.checked)}
                data-testid="chat-look-marks"
              />
              {t("chat.look.showMarks")}
            </label>
          )}
          <span className={styles.grow} />
          {time !== undefined && (
            <button
              type="button"
              data-testid="chat-look-playhead"
              onClick={() => {
                workbench.goToRef(
                  `aq://time?timeline=${encodeURIComponent(look.timeline)}&t=${encodeURIComponent(time)}`,
                );
                onClose();
              }}
            >
              {t("chat.look.playhead")}
            </button>
          )}
          <button
            type="button"
            disabled={at === 0}
            onClick={() => onMove(at - 1)}
            aria-label={t("chat.look.previous")}
          >
            <ChevronLeft size={12} aria-hidden />
          </button>
          <button
            type="button"
            disabled={at >= items.length - 1}
            onClick={() => onMove(at + 1)}
            aria-label={t("chat.look.next")}
          >
            <ChevronRight size={12} aria-hidden />
          </button>
        </div>
        <details className={styles.raw}>
          <summary>{t("chat.look.list")}</summary>
          <pre>{text}</pre>
        </details>
      </div>
    </div>,
    document.body,
  );
}
