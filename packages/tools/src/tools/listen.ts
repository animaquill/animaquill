import {
  buildAudioPlan,
  entryOf,
  formatOf,
  timelineLength,
  type ProjectState,
} from "@animaquill/core";
import { Time, compare, formatTime, parseTime, toSeconds } from "@animaquill/schema";
import { z } from "zod";
import { answer, failed, named } from "../context.ts";
import { mostLike } from "../similar.ts";
import { PARAM } from "../texts/index.ts";
import type { ToolDefinition } from "../tool.ts";
import type { Heard, ListenFailure } from "../types.ts";

/** How long a part one call mixes is at most, in seconds: longer parts go in several calls. */
export const MOST_LISTEN_SECONDS = 600;
/** How many parts the small picture of the level has, for people. */
export const WAVE_BUCKETS = 240;
/** At most this many places of clipping and stretches of silence go to the model with their times. */
const MOST_LISTED = 12;
/** The measures there are, in the order a result says them. */
export const LISTEN_WHATS = ["loudness", "silence", "clipping", "envelope"] as const;
export type ListenWhat = (typeof LISTEN_WHATS)[number];

const ListenParams = z.strictObject({
  range: z.strictObject({ from: Time, to: Time }).optional().describe(PARAM),
  timeline: z.string().optional().describe(PARAM),
  version: z.string().optional().describe(PARAM),
  clip: z.string().optional().describe(PARAM),
  what: z.array(z.enum(LISTEN_WHATS)).min(1).max(4).optional().describe(PARAM),
});

type Params = z.output<typeof ListenParams>;

/** What a call of `aq_audio_analyze` keeps for people with its result (`data.listen`). */
export interface ListenData {
  readonly timeline: string;
  readonly timelineName?: string;
  /** Seconds on the timeline. */
  readonly from: number;
  readonly to: number;
  /** Only this clip was heard; `made` where code makes its sound. */
  readonly clip?: string;
  readonly clipName?: string;
  readonly made?: true;
  readonly what: readonly ListenWhat[];
  /** LUFS, dBTP and dBFS; none where silence has none. */
  readonly integrated?: number;
  readonly shortTermMax?: number;
  readonly truePeak?: number;
  readonly samplePeak?: number;
  readonly clipping?: { readonly places: number; readonly samples: number };
  /** Seconds on the timeline. */
  readonly clips?: readonly { readonly from: number; readonly to: number }[];
  readonly silences?: readonly { readonly from: number; readonly to: number }[];
  readonly silent?: true;
  /** Seconds. */
  readonly envelope?: {
    readonly peak: number;
    readonly attack: number;
    readonly decay: number;
    readonly cut?: true;
  };
  /** The level over the part, the largest sample of each of `WAVE_BUCKETS` parts, 0–1. */
  readonly wave?: readonly number[];
  readonly failure?: ListenFailure & { readonly clipName?: string; readonly assetName?: string };
}

const timelineOf = (state: ProjectState, id: string | undefined) => {
  const wanted = id ?? state.manifest.timelines[0];
  const timeline = wanted === undefined ? undefined : entryOf(state.timelines, wanted);
  return wanted !== undefined && timeline ? ([wanted, timeline] as const) : undefined;
};

/** Seconds as times are written, to the millisecond: "12.5", "0.012". */
const secondsText = (seconds: number) => String(Math.round(seconds * 1000) / 1000);
const db = (value: number) => (Math.round(value * 10) / 10).toFixed(1);
const ms = (seconds: number) => `${Math.round(seconds * 1000)} ms`;

/** Why the mix failed, in the words of the result, with the names that go with it. */
function failureWords(
  state: ProjectState,
  timeline: string,
  failure: ListenFailure,
): { readonly text: string; readonly clipName?: string; readonly assetName?: string } {
  if (failure.reason === "stopped") return { text: "the task was stopped" };
  if (failure.reason === "failed")
    return { text: `mixing failed in this browser: ${failure.message}` };
  const clip = entryOf(entryOf(state.timelines, timeline)?.clips ?? {}, failure.layer);
  const clipName = clip?.name;
  const media = (clip?.source as { readonly media?: { readonly asset?: string } } | undefined)
    ?.media;
  const asset = media?.asset === undefined ? undefined : entryOf(state.assets, media.asset);
  const assetName = asset?.name;
  const clipWords = `clip ${named(failure.layer, clipName)}`;
  const assetWords =
    media?.asset === undefined ? "its file" : `asset ${named(media.asset, assetName)}`;
  const names = { ...(clipName && { clipName }), ...(assetName && { assetName }) };
  switch (failure.reason) {
    case "missing-file":
      return {
        text: `${clipWords} plays ${assetWords}, whose file is not on this computer`,
        ...names,
      };
    case "cannot-decode":
      return {
        text: `${clipWords} plays ${assetWords}, which this browser cannot decode`,
        ...names,
      };
    case "not-made":
      return {
        text: `the code of the sound of ${clipWords} did not make it (${failure.why})`,
        ...names,
      };
  }
}

/** Places on the timeline, a few of them with how many there are in all. */
function placesText(
  places: readonly { readonly from: number; readonly to: number }[],
  all: number,
  each: (place: { readonly from: number; readonly to: number }, index: number) => string,
): string {
  const listed = places.slice(0, MOST_LISTED).map(each);
  const more = all - listed.length;
  return `${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

const LISTEN_TITLE = "Analyze audio";

export const audioAnalyze: ToolDefinition<Params> = {
  name: "aq_audio_analyze",
  title: LISTEN_TITLE,
  params: ListenParams,
  check: (args) => {
    if (args.range && compare(parseTime(args.range.from), parseTime(args.range.to)) >= 0)
      return failed(
        "error invalid-params\n  range.from has to be before range.to\nnothing was measured",
      );
    return undefined;
  },
  run: async (call, args) => {
    const { host, store } = call;
    if (!host.listen) {
      return failed(
        "error not-available: this place cannot mix sound; the AnimaQuill editor in the browser can.",
      );
    }
    const state = store.getState();
    const found = timelineOf(state, args.timeline);
    if (!found) {
      const similar = mostLike(args.timeline ?? "", Object.keys(state.timelines));
      const hint = similar.length > 0 ? `\nsimilar: ${similar.join(" | ")}` : "";
      return failed(`error not-found: no timeline ${JSON.stringify(args.timeline ?? "")}${hint}`);
    }
    const [timeline, timelineState] = found;
    const format = formatOf(
      state,
      args.version === undefined ? undefined : { format: args.version },
    );
    if (!format) {
      const ids = state.manifest.formats.map(({ id }) => id).join(", ");
      return failed(
        `error not-found: no picture format ${JSON.stringify(args.version)}; the project has ${ids}.`,
      );
    }
    const plan = buildAudioPlan(state, timeline);
    let sound: (typeof plan.sounds)[number] | undefined;
    if (args.clip !== undefined) {
      const clip = entryOf(timelineState.clips, args.clip);
      if (!clip) {
        const similar = mostLike(args.clip, Object.keys(timelineState.clips));
        const hint = similar.length > 0 ? `\nsimilar: ${similar.join(" | ")}` : "";
        return failed(
          `error not-found: no clip ${JSON.stringify(args.clip)} in timeline ${timeline}${hint}`,
        );
      }
      sound = plan.sounds.find(({ id }) => id === args.clip);
      if (!sound)
        return failed(
          `error invalid-params: clip ${named(args.clip, clip.name)} is not heard: it has no sound, it is hidden, or its track is muted or not soloed while others are.`,
        );
    }
    const length = timelineLength(timelineState);
    const end = toSeconds(length);
    const from = args.range ? toSeconds(parseTime(args.range.from)) : (sound?.start ?? 0);
    const to = args.range ? toSeconds(parseTime(args.range.to)) : (sound?.end ?? end);
    if (args.range && compare(parseTime(args.range.to), length) > 0)
      return failed(
        `error out-of-range: range.to ${args.range.to} is past the end of timeline ${timeline}, which is ${formatTime(length)} long.`,
      );
    if (to - from <= 0)
      return failed(`error out-of-range: timeline ${timeline} is empty; there is nothing to hear.`);
    if (to - from > MOST_LISTEN_SECONDS)
      return failed(
        `error invalid-params: ${secondsText(to - from)} s is longer than one call measures (${MOST_LISTEN_SECONDS} s); give a range, and measure a long timeline in parts.`,
      );
    const what: readonly ListenWhat[] =
      args.what ??
      (sound ? ["loudness", "clipping", "envelope"] : ["loudness", "silence", "clipping"]);
    const wants = (each: ListenWhat) => what.includes(each);
    const heard = await host.listen({
      state,
      timeline,
      from,
      to,
      ...(sound && { only: sound.id }),
      envelope: wants("envelope"),
      buckets: WAVE_BUCKETS,
    });
    const clip = sound ? entryOf(timelineState.clips, sound.id) : undefined;
    const base = {
      timeline,
      ...(timelineState.name !== undefined && { timelineName: timelineState.name }),
      from,
      to,
      ...(sound && { clip: sound.id }),
      ...(clip?.name !== undefined && { clipName: clip.name }),
      ...(sound?.made && { made: true as const }),
      what,
    };
    if (!heard.ok) {
      const words = failureWords(state, timeline, heard.failure);
      const data: ListenData = {
        ...base,
        failure: {
          ...heard.failure,
          ...(words.clipName && { clipName: words.clipName }),
          ...(words.assetName && { assetName: words.assetName }),
        },
      };
      return failed(
        `error mix-failed: the sound from ${secondsText(from)} to ${secondsText(to)} cannot be mixed: ${words.text}. A mix with a sound missing is not what the export gives, so nothing was measured.`,
        { listen: data },
      );
    }
    return answer(
      call,
      linesOf(heard.heard, from, to, timeline, timelineState.name, sound?.id, clip?.name, what),
      {
        listen: dataOf(heard.heard, base, from, wants),
      },
    );
  },
};

function linesOf(
  heard: Heard,
  from: number,
  to: number,
  timeline: string,
  timelineName: string | undefined,
  only: string | undefined,
  clipName: string | undefined,
  what: readonly ListenWhat[],
): string[] {
  const at = (seconds: number) => secondsText(from + seconds);
  const lines = [
    `${only ? `clip ${named(only, clipName)} alone` : "the mix"} of timeline ${named(timeline, timelineName)} from ${secondsText(from)} to ${secondsText(to)} (${secondsText(to - from)} s), as the export mixes it: stereo, 48000 Hz`,
  ];
  if (heard.silent) lines.push("all of it is silent: below -50 dBFS");
  for (const each of LISTEN_WHATS.filter((kind) => what.includes(kind))) {
    switch (each) {
      case "loudness": {
        const parts = [
          heard.integrated === undefined
            ? "integrated: none (silent, or shorter than 0.4 s)"
            : `integrated ${db(heard.integrated)} LUFS`,
          heard.shortTermMax === undefined
            ? "short-term max: none (shorter than 3 s)"
            : `short-term max ${db(heard.shortTermMax)} LUFS`,
          heard.truePeak === null ? "true peak: none" : `true peak ${db(heard.truePeak)} dBTP`,
          heard.samplePeak === null ? "" : `sample peak ${db(heard.samplePeak)} dBFS`,
        ];
        lines.push(`loudness: ${parts.filter(Boolean).join("; ")}`);
        break;
      }
      case "clipping":
        lines.push(
          heard.clipping.places === 0
            ? "clipping: none"
            : `clipping: ${heard.clipping.places} place(s), ${heard.clipping.samples} sample(s) at or over full scale: ${placesText(
                heard.clips,
                heard.clipping.places,
                (place, index) =>
                  `t=${at(place.from)} (${heard.clips[index]?.samples ?? 0} samples)`,
              )}`,
        );
        break;
      case "silence":
        lines.push(
          heard.silences.length === 0
            ? "silence (below -50 dBFS for 0.3 s or longer): none"
            : `silence (below -50 dBFS for 0.3 s or longer): ${placesText(
                heard.silences,
                heard.silences.length,
                (stretch) => `${at(stretch.from)}-${at(stretch.to)}`,
              )}`,
        );
        break;
      case "envelope": {
        const envelope = heard.envelope;
        lines.push(
          envelope === undefined
            ? "envelope: none (silent)"
            : `envelope: peak ${db(envelope.peak)} dBFS at t=${at(envelope.peakAt)}; starts at t=${at(envelope.onset)}; attack ${ms(envelope.attack)} (10% to 90% of the peak); decay ${secondsText(envelope.decay)} s (from the peak to 40 dB below it)${envelope.cut ? "; still sounding where the range ends" : ""}`,
        );
        break;
      }
    }
  }
  return lines;
}

function dataOf(
  heard: Heard,
  base: Omit<ListenData, "failure">,
  from: number,
  wants: (each: ListenWhat) => boolean,
): ListenData {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const on = (stretch: { readonly from: number; readonly to: number }) => ({
    from: round(from + stretch.from),
    to: round(from + stretch.to),
  });
  const envelope = heard.envelope;
  return {
    ...base,
    ...(wants("loudness") && {
      ...(heard.integrated !== undefined && { integrated: round(heard.integrated) }),
      ...(heard.shortTermMax !== undefined && { shortTermMax: round(heard.shortTermMax) }),
      ...(heard.truePeak !== null && { truePeak: round(heard.truePeak) }),
      ...(heard.samplePeak !== null && { samplePeak: round(heard.samplePeak) }),
    }),
    ...(wants("clipping") && { clipping: heard.clipping, clips: heard.clips.map(on) }),
    ...(wants("silence") && { silences: heard.silences.map(on) }),
    ...(heard.silent && { silent: true as const }),
    ...(wants("envelope") &&
      envelope && {
        envelope: {
          peak: round(envelope.peak),
          attack: round(envelope.attack),
          decay: round(envelope.decay),
          ...(envelope.cut && { cut: true as const }),
        },
      }),
    wave: heard.wave,
  };
}
