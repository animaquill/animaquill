import type { ToolCallEntry, ToolEntry } from "@animaquill/agent";
import type { ListenData } from "@animaquill/tools";
import { Check, ChevronDown, ChevronRight, LoaderCircle, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import styles from "./ChatPanel.module.css";
import { useNow } from "./clock.ts";
import { useOpened } from "./expanded.ts";
import { timeText, toolErrorCode, type Names, type Say } from "./toolSummary.ts";
import { durationText } from "./turns.ts";

/**
 * AI heard the sound (mcp.md 8, 6.11a): its row says the loudness, the peak, how many places clip
 * and how many stretches are silent, and shows right under it a small picture of the level, with
 * the clips red and the silences grey; a click goes there on the timeline. A sound made by code
 * says its attack and decay. Where the sound could not be mixed the row is red and says why.
 */

/** A call quicker than this says nothing of how long it took. */
const SHOWN_MS = 100;

export const listenOf = (result: ToolEntry | undefined): ListenData | undefined => {
  const listen = result?.data?.listen;
  return typeof listen === "object" && listen !== null ? (listen as ListenData) : undefined;
};

/** A level as people read it: one decimal, with a real minus sign. */
const level = (value: number) => (Math.round(value * 10) / 10).toFixed(1).replace("-", "−");
/** Seconds as the chat writes times: 0:12, 0:12.5. */
const at = (seconds: number) => timeText(String(Math.round(seconds * 10) / 10)) ?? String(seconds);

/** What AI heard, in a few words after its name. */
export function listenSummary(say: Say, listen: ListenData): string {
  if (listen.failure) {
    const failure = listen.failure;
    const reason = say(`chat.listen.why.${failure.reason}`, {
      clip: failure.clipName ?? ("layer" in failure ? failure.layer : ""),
      asset: failure.assetName ?? say("chat.listen.someAsset"),
      defaultValue: say("chat.listen.why.failed"),
    });
    return say("chat.listen.failed", { reason });
  }
  const parts = [`${at(listen.from)}–${at(listen.to)}`];
  if (listen.clip !== undefined) parts.unshift(`「${listen.clipName ?? listen.clip}」`);
  if (listen.silent) parts.push(say("chat.listen.silent"));
  if (listen.envelope)
    parts.push(
      say("chat.listen.envelope", {
        attack: Math.round(listen.envelope.attack * 1000),
        decay: Math.round(listen.envelope.decay * 10) / 10,
      }),
    );
  if (listen.integrated !== undefined && listen.clip === undefined)
    parts.push(say("chat.listen.loudness", { value: level(listen.integrated) }));
  if (listen.truePeak !== undefined)
    parts.push(say("chat.listen.peak", { value: level(listen.truePeak) }));
  if (listen.clipping && listen.clipping.places > 0)
    parts.push(say("chat.listen.clips", { count: listen.clipping.places }));
  if (listen.silences && listen.silences.length > 0 && !listen.silent)
    parts.push(say("chat.listen.silences", { count: listen.silences.length }));
  return parts.join(" · ");
}

/** The level over the part AI heard, with where it clips and where it is silent: a click goes there. */
function Wave({ listen }: { readonly listen: ListenData }) {
  const workbench = useWorkbench();
  const { t } = useTranslation();
  const wave = listen.wave ?? [];
  const length = Math.max(listen.to - listen.from, 1e-6);
  const go = (seconds: number) =>
    workbench.goToRef(
      `aq://time?timeline=${encodeURIComponent(listen.timeline)}&t=${encodeURIComponent(String(Math.round(seconds * 1000) / 1000))}`,
    );
  const share = (seconds: number) => `${((seconds - listen.from) / length) * 100}%`;
  const onWave = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && !(event.target instanceof SVGElement)) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width)));
    go(listen.from + x * length);
  };
  const width = wave.length;
  const path = wave
    .map((value, index) => {
      const half = Math.max(0.02, Math.min(1, value)) * 16;
      return `M${index + 0.5} ${17 - half}V${17 + half}`;
    })
    .join("");
  return (
    // A click on the level goes to that moment; the marks are buttons of their own.
    <div className={styles.listenWave} data-testid="chat-listen-wave" onClick={onWave}>
      <svg viewBox={`0 0 ${Math.max(1, width)} 34`} preserveAspectRatio="none" aria-hidden>
        <path d={path} className={styles.listenLevel} />
      </svg>
      {(listen.silences ?? []).map((stretch) => (
        <button
          key={`s${stretch.from}`}
          type="button"
          className={styles.listenSilence}
          data-testid="chat-listen-silence"
          style={{
            left: share(stretch.from),
            width: `${((stretch.to - stretch.from) / length) * 100}%`,
          }}
          aria-label={t("chat.listen.at", { time: at(stretch.from) })}
          title={`${at(stretch.from)}–${at(stretch.to)}`}
          onClick={() => go(stretch.from)}
        />
      ))}
      {(listen.clips ?? []).map((place) => (
        <button
          key={`c${place.from}`}
          type="button"
          className={styles.listenClip}
          data-testid="chat-listen-clip"
          style={{ left: share(place.from) }}
          aria-label={t("chat.listen.at", { time: at(place.from) })}
          title={at(place.from)}
          onClick={() => go(place.from)}
        />
      ))}
    </div>
  );
}

export function ListenRow({
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
  const now = useNow(running !== undefined);
  const listen = listenOf(result);
  const state =
    result === undefined
      ? running !== undefined
        ? "running"
        : "waiting"
      : failed
        ? "failed"
        : "ok";
  const code = result && !result.ok && !listen?.failure ? toolErrorCode(result) : undefined;
  const summary = code
    ? say(`chat.toolErrors.${code}`, { defaultValue: say("chat.toolErrors.other", { code }), code })
    : listen
      ? listenSummary(say, listen)
      : "";
  const ms =
    result?.startedAt !== undefined
      ? result.at - result.startedAt
      : running !== undefined
        ? now - running
        : undefined;
  const name = result === undefined ? say("chat.tool.aq_audio_analyze") : say("chat.listen.name");
  return (
    <div className={styles.tool} data-state={state} data-testid="chat-tool" data-listen="">
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
      {listen && !listen.failure && (listen.wave?.length ?? 0) > 0 && <Wave listen={listen} />}
      {open && result && (
        <div className={styles.toolBody} data-testid="chat-tool-body">
          <details className={styles.raw} open>
            <summary>{t("chat.listen.list")}</summary>
            <pre>{result.text}</pre>
          </details>
        </div>
      )}
    </div>
  );
}
