import {
  entryOf,
  formatOf,
  timelineLength,
  type ProjectState,
  type Rect,
  type RenderPlan,
} from "@animaquill/core";
import { Time, compare, formatTime, parseTime, rational, toSeconds } from "@animaquill/schema";
import { z } from "zod";
import { answer, failed, named, quoted } from "../context.ts";
import {
  SIDES,
  frameFacts,
  overlapOf,
  pictureRect,
  planOf,
  type ClipFact,
  type FrameFacts,
  type Side,
} from "../look-facts.ts";
import { mostLike } from "../similar.ts";
import { PARAM } from "../texts/index.ts";
import type { ToolDefinition } from "../tool.ts";
import type {
  LookAnswer,
  LookFailure,
  LookImageRole,
  LookMark,
  LookShot,
  LookSize,
  LookedShot,
  ToolImage,
  ToolResult,
} from "../types.ts";

/** How large each size is on the longer side of a picture, in pixels. */
export const LOOK_SIDES: Readonly<Record<LookSize, number>> = {
  small: 512,
  medium: 1024,
  large: 1568,
};

/** What a picture costs a model, about: Anthropic counts width × height / 750 tokens. */
export const tokensOf = (width: number, height: number): number =>
  Math.ceil((width * height) / 750);

export const MOST_TIMES = 8;
/** A comparison gives three pictures for each moment. */
export const MOST_COMPARED = 4;
export const MOST_CELLS = 24;
export const DEFAULT_CELLS = 12;
const MOST_MARKS = 20;
/** At most this many findings of one frame go to people with the result. */
const MOST_FINDINGS = 6;

const Region = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const LookParams = z.strictObject({
  times: z.array(Time).min(1).max(MOST_TIMES).optional().describe(PARAM),
  range: z.strictObject({ from: Time, to: Time }).optional().describe(PARAM),
  count: z.number().int().min(2).max(MOST_CELLS).optional().describe(PARAM),
  timeline: z.string().optional().describe(PARAM),
  version: z.string().optional().describe(PARAM),
  size: z.enum(["small", "medium", "large"]).optional().describe(PARAM),
  region: Region.optional().describe(PARAM),
  annotate: z
    .union([z.boolean(), z.array(z.string()).min(1).max(MOST_MARKS)])
    .optional()
    .describe(PARAM),
  compare: z.string().optional().describe(PARAM),
});

type Params = z.output<typeof LookParams>;

/** What kind of look a call is, for people. */
export type LookKind = "frames" | "overview" | "zoom" | "compare";

/** Something on a frame worth a line under its picture, for people: drawn from what AI read. */
export type LookFinding =
  | {
      readonly kind: "past";
      readonly id: string;
      readonly name?: string;
      readonly side: Side;
      /** In pixels of the format. */
      readonly by: number;
    }
  | { readonly kind: "text-past"; readonly text: string; readonly side: Side; readonly by: number }
  | { readonly kind: "outside"; readonly id: string; readonly name?: string }
  | {
      readonly kind: "overlap";
      readonly id: string;
      readonly name?: string;
      readonly other: string;
      readonly otherName?: string;
    };

/** One moment of a look, for people. */
export interface LookShotData {
  readonly t: string;
  readonly seconds: number;
  readonly findings: readonly LookFinding[];
  /** Of a comparison. */
  readonly changed?: { readonly ratio: number; readonly box?: Rect };
}

/** What a call of `aq_render_frames` keeps for people with its result (`data.look`). */
export interface LookData {
  readonly kind: LookKind;
  readonly timeline: string;
  readonly timelineName?: string;
  /** The picture in world units, and how many pixels of the format a unit is. */
  readonly stage: { readonly width: number; readonly height: number };
  readonly unit: number;
  readonly region?: Rect;
  readonly range?: { readonly from: string; readonly to: string };
  readonly annotated: boolean;
  /** The model got the pictures. */
  readonly sees: boolean;
  /** About how many tokens the pictures that went to the model took. */
  readonly tokens: number;
  /** What it was compared with: the start of the task, or a revision. */
  readonly against?: string;
  readonly shots: readonly LookShotData[];
  /** Where the frame could not be rendered. */
  readonly failure?: LookFailure & {
    readonly t: string;
    readonly before?: true;
    readonly clipName?: string;
    readonly assetName?: string;
  };
}

const round = (value: number) => String(Math.round(value));
const rectText = (rect: Rect) =>
  `${round(rect.x)},${round(rect.y)} ${round(rect.width)}×${round(rect.height)}`;
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
const ratioText = (ratio: number) => String(Math.round(ratio * 1000) / 1000);
const pastText = (past: Partial<Record<Side, number>>) =>
  SIDES.filter((side) => past[side] !== undefined)
    .map((side) => `${side} ${round(past[side] as number)}`)
    .join(", ");

const timelineOf = (state: ProjectState, id: string | undefined) => {
  const wanted = id ?? state.manifest.timelines[0];
  const timeline = wanted === undefined ? undefined : entryOf(state.timelines, wanted);
  return wanted !== undefined && timeline ? ([wanted, timeline] as const) : undefined;
};

/** The frame a moment is in, at a frame rate: the export renders frames, not moments between. */
function onFrame(time: string, fps: string): string {
  const t = parseTime(time);
  const rate = parseTime(fps);
  const frame = (t.n * rate.n) / (t.d * rate.d);
  return formatTime(rational(frame * rate.d, rate.n));
}

/** A clip as results name it, with its name where it has one. */
const clipText = (clip: Pick<ClipFact, "id" | "name">) => named(clip.id, clip.name);

/** The lines of what is on a frame, back to front. */
export function factLines(facts: FrameFacts): string[] {
  const lines = [`clips, back to front (${facts.clips.length}):`];
  for (const clip of facts.clips) {
    const parts = [
      `- ${clipText(clip)} ${clip.source} box ${rectText(clip.box)}`,
      `${percent(clip.share)} of the picture`,
      `opacity ${Math.round(clip.opacity * 100) / 100}`,
    ];
    if (clip.outside) parts.push("outside the picture");
    else if (Object.keys(clip.past).length > 0) parts.push(`past the edge: ${pastText(clip.past)}`);
    if (clip.cropped) parts.push("media cut to its box (fit cover)");
    if (clip.stretched) {
      const { fit, wider } = clip.stretched;
      const shape =
        wider >= 1
          ? `${ratioText(wider)}× wider than its own proportions`
          : `${ratioText(1 / wider)}× taller than its own proportions`;
      parts.push(`media stretched out of shape: ${shape} (fit ${fit})`);
    }
    if (clip.overlaps.length > 0) {
      const others = clip.overlaps.map((id) => {
        const other = facts.clips.find((each) => each.id === id);
        return other ? clipText(other) : id;
      });
      parts.push(`overlaps ${others.join(", ")}`);
    }
    lines.push(parts.join("; "));
    for (const text of clip.texts) {
      const past =
        Object.keys(text.past).length > 0 ? `; past the edge: ${pastText(text.past)}` : "";
      lines.push(`  text ${quoted(text.text)} box ${rectText(text.box)}${past}`);
    }
  }
  if (facts.clips.length === 0) lines.push("- nothing: the background only");
  if (facts.unseen > 0)
    lines.push(`${facts.unseen} more clip(s) at this moment show nothing (opacity 0 or no size)`);
  if (facts.moreTexts > 0) lines.push(`${facts.moreTexts} more text element(s) not listed`);
  return lines;
}

/** One line of an overview: which clips show, and what goes past the edges. */
function cellLine(t: string, facts: FrameFacts): string {
  const clips = facts.clips.map((clip) => {
    const past = Object.keys(clip.past).length > 0 ? ` (past ${pastText(clip.past)})` : "";
    return `${clipText(clip)}${clip.outside ? " (outside)" : past}`;
  });
  return `t=${t}: ${clips.join(", ") || "background only"}`;
}

/** What people see under the pictures of a frame. */
function findingsOf(facts: FrameFacts, unit: number): LookFinding[] {
  const found: LookFinding[] = [];
  const name = (clip: ClipFact) => (clip.name ? { name: clip.name } : {});
  for (const clip of facts.clips) {
    if (clip.outside) found.push({ kind: "outside", id: clip.id, ...name(clip) });
    else {
      for (const side of SIDES) {
        const by = clip.past[side];
        if (by !== undefined && clip.share < 0.99)
          found.push({ kind: "past", id: clip.id, ...name(clip), side, by: Math.round(by * unit) });
      }
    }
    for (const text of clip.texts) {
      for (const side of SIDES) {
        const by = text.past[side];
        if (by !== undefined)
          found.push({
            kind: "text-past",
            text: text.text.slice(0, 40),
            side,
            by: Math.round(by * unit),
          });
      }
    }
    for (const other of clip.overlaps) {
      const them = facts.clips.find((each) => each.id === other);
      // Each pair once.
      if (!them || them.depth < clip.depth) continue;
      found.push({
        kind: "overlap",
        id: clip.id,
        ...name(clip),
        other,
        ...(them.name ? { otherName: them.name } : {}),
      });
    }
  }
  return found.slice(0, MOST_FINDINGS);
}

/** The clips to draw boxes of, from what shows: all of them, or those asked for. */
function marksOf(facts: FrameFacts, annotate: Params["annotate"]): LookMark[] {
  if (annotate === undefined || annotate === false) return [];
  const wanted = annotate === true ? undefined : new Set(annotate);
  return facts.clips
    .filter((clip) => !clip.outside && (wanted === undefined || wanted.has(clip.id)))
    .slice(0, MOST_MARKS)
    .map((clip) => ({
      box: clip.box,
      label: clip.name ? `${clip.id} ${clip.name}` : clip.id,
      problem: Object.keys(clip.past).length > 0 && clip.share < 0.99,
    }));
}

/** Why a frame could not be rendered, in the words of the result, with the names that go with it. */
function failureWords(
  state: ProjectState,
  timeline: string,
  failure: LookFailure,
): { readonly text: string; readonly clipName?: string; readonly assetName?: string } {
  const layer = "layer" in failure ? failure.layer : undefined;
  const clip =
    layer === undefined
      ? undefined
      : entryOf(entryOf(state.timelines, timeline)?.clips ?? {}, layer);
  const clipName = clip?.name;
  const clipWords = layer === undefined ? "" : `clip ${named(layer, clipName)}`;
  const media = (clip?.source as { readonly media?: { readonly asset?: string } } | undefined)
    ?.media;
  const asset = media?.asset === undefined ? undefined : entryOf(state.assets, media.asset);
  const assetName = asset?.name;
  const assetWords =
    media?.asset === undefined ? "its file" : `asset ${named(media.asset, assetName)}`;
  const names = { ...(clipName && { clipName }), ...(assetName && { assetName }) };
  switch (failure.reason) {
    case "missing-file":
      return {
        text: `${clipWords} shows ${assetWords}, whose file is not on this computer`,
        ...names,
      };
    case "cannot-decode":
      return {
        text: `${clipWords} shows ${assetWords}, whose file this browser cannot decode`,
        ...names,
      };
    case "scene": {
      const why =
        failure.state === "off"
          ? "scenes are turned off in this editor"
          : failure.state === "unsupported"
            ? "this browser cannot capture scenes"
            : failure.state === "too-new"
              ? "its scene was written for a newer editor"
              : failure.state === "stopped"
                ? `its scene stopped${failure.message ? `: ${failure.message}` : ""}`
                : `its scene is not running (${failure.state})`;
      return { text: `${clipWords} cannot be drawn: ${why}`, ...names };
    }
    case "transition":
      return { text: `${clipWords} has a transition this editor cannot draw yet`, ...names };
    case "scene-frame":
      return {
        text: `the scene of ${clipWords} did not give its frame ${failure.wanted}`,
        ...names,
      };
    case "encoder":
    case "failed":
      return { text: `drawing failed in this browser: ${failure.message}` };
    case "compositor":
      return { text: "the renderer of the editor stopped answering" };
    case "stopped":
      return { text: "the task was stopped" };
  }
}

/** A picture of the call, with the line that says what it is. */
function imageOf(
  picture: NonNullable<LookedShot["picture"]>,
  role: LookImageRole,
  shot: number,
  note: string,
  forPeople = false,
): ToolImage {
  return { ...picture, note, role, shot, ...(forPeople && { forPeople: true as const }) };
}

/** Where the changed pixels are, from pixels of the picture to the world. */
function worldOfPixels(
  box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  width: number,
  height: number,
  shown: Rect,
): Rect {
  const sx = shown.width / width;
  const sy = shown.height / height;
  return {
    x: shown.x + box.x * sx,
    y: shown.y + box.y * sy,
    width: box.width * sx,
    height: box.height * sy,
  };
}

const LOOK_TITLE = "Render frames";

export const renderFrames: ToolDefinition<Params> = {
  name: "aq_render_frames",
  title: LOOK_TITLE,
  params: LookParams,
  check: (args) => {
    const lines: string[] = [];
    if ((args.times === undefined) === (args.range === undefined))
      lines.push("give either times (moments) or range (an overview), one of them");
    if (args.count !== undefined && args.range === undefined)
      lines.push("count goes only with range");
    if (args.range && (args.compare !== undefined || args.region !== undefined))
      lines.push("an overview (range) takes neither compare nor region; give times for those");
    if (args.compare !== undefined && (args.times?.length ?? 0) > MOST_COMPARED)
      lines.push(`compare takes at most ${MOST_COMPARED} times, as each gives three pictures`);
    if (args.range && compare(parseTime(args.range.from), parseTime(args.range.to)) >= 0)
      lines.push("range.from has to be before range.to");
    return lines.length === 0
      ? undefined
      : failed(
          [
            "error invalid-params",
            ...lines.map((line) => `  ${line}`),
            "nothing was rendered",
          ].join("\n"),
        );
  },
  run: async (call, args) => {
    const { host, store, caller } = call;
    if (!host.look) {
      return failed(
        "error not-available: this place cannot render frames; the AnimaQuill editor in the browser can.",
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
    const plan = planOf(state, timeline, format.id) as RenderPlan;
    const length = timelineLength(timelineState);
    const end = formatTime(length);
    const picture = pictureRect(plan.stage);
    const unit = format.width / plan.stage.width;

    // The moments, each on the frame the export renders there.
    const asked = args.times ?? [];
    let times: string[];
    if (args.range) {
      const from = parseTime(args.range.from);
      const to = parseTime(args.range.to);
      const count = args.count ?? DEFAULT_CELLS;
      const step = toSeconds(to) - toSeconds(from);
      times = Array.from({ length: count }, (_, index) =>
        onFrame(
          String(Math.round((toSeconds(from) + (step * index) / count) * 1e6) / 1e6),
          format.fps,
        ),
      );
      if (compare(to, length) > 0)
        return failed(
          `error out-of-range: range.to ${args.range.to} is past the end of timeline ${timeline}, which is ${end} long.`,
        );
    } else {
      const late = asked.filter((time) => compare(parseTime(time), length) >= 0);
      if (late.length > 0)
        return failed(
          `error out-of-range: t=${late.join(", ")} is not before the end of timeline ${timeline}, which is ${end} long; times go from 0 to just before ${end}.`,
        );
      times = asked.map((time) => onFrame(time, format.fps));
    }
    if (args.region && !overlapOf(args.region, picture)) {
      return failed(
        `error invalid-params: region ${rectText(args.region)} is not on the picture, which is ${rectText(picture)} in world units.`,
      );
    }

    // What to compare with: the project as the task started, or at a revision a result told of.
    let before: ProjectState | undefined;
    let against: string | undefined;
    if (args.compare !== undefined) {
      const wanted = args.compare.trim().replace(/^rev\s+/, "");
      if (wanted === "task_start") {
        before = host.taskStart?.();
        if (!before)
          return failed(
            "error not-available: this place keeps no state of the project from the start of the task; compare with a revision that an earlier result of this conversation started with.",
          );
        against = "task_start";
      } else {
        before = caller.stateAt(wanted);
        if (!before)
          return failed(
            `error not-found: revision ${JSON.stringify(wanted)} is not one that a result of this conversation started with, since the editor opened; compare takes "task_start" or such a revision.`,
          );
        against = wanted;
      }
      if (!entryOf(before.timelines, timeline))
        return failed(`error not-found: timeline ${timeline} did not exist then (${against}).`);
    }

    const sheet = args.range !== undefined;
    const columns = sheet ? Math.ceil(Math.sqrt(times.length * 1.5)) : undefined;
    const planned = times.map((t) => frameFacts(state, timeline, plan, toSeconds(parseTime(t))));
    const shots: LookShot[] = times.map((t, index) => ({
      seconds: toSeconds(parseTime(t)),
      label: t,
      marks: marksOf(planned[index] as FrameFacts, args.annotate),
    }));
    const looked: LookAnswer = await host.look({
      state,
      ...(before && { before }),
      timeline,
      format: format.id,
      kind: sheet ? "sheet" : "frames",
      shots,
      ...(columns !== undefined && { columns }),
      size: args.size,
      ...(args.region && { region: args.region }),
      texts: !sheet,
    });
    const kind: LookKind = sheet
      ? "overview"
      : before
        ? "compare"
        : args.region
          ? "zoom"
          : "frames";
    const base = {
      kind,
      timeline,
      ...(timelineState.name !== undefined && { timelineName: timelineState.name }),
      stage: { width: plan.stage.width, height: plan.stage.height },
      unit,
      ...(args.region && { region: args.region }),
      ...(args.range && { range: { from: args.range.from, to: args.range.to } }),
      annotated: shots.some(({ marks }) => marks.length > 0),
      ...(against !== undefined && { against }),
    };
    if (!looked.ok) {
      const t = times[looked.shot] ?? times[0] ?? "0";
      const words = failureWords(
        looked.before ? (before ?? state) : state,
        timeline,
        looked.failure,
      );
      const data: LookData = {
        ...base,
        sees: false,
        tokens: 0,
        shots: [],
        failure: {
          ...looked.failure,
          t,
          ...(looked.before && { before: true as const }),
          ...(words.clipName && { clipName: words.clipName }),
          ...(words.assetName && { assetName: words.assetName }),
        },
      };
      const when = looked.before ? ` as it was (${against})` : "";
      return failed(
        `error render-failed: t=${t}${when} cannot be rendered: ${words.text}. A picture with something missing would not be what the export renders, so nothing was rendered.`,
        { look: data },
      );
    }

    // What was rendered, and what is on each frame with the text of its scenes.
    const measured = times.map((t, index) =>
      sheet
        ? (planned[index] as FrameFacts)
        : frameFacts(
            state,
            timeline,
            plan,
            toSeconds(parseTime(t)),
            looked.shots[index]?.texts ?? [],
          ),
    );
    const shown: Rect = args.region ?? picture;
    const images: ToolImage[] = [];
    const lines: string[] = [];
    const timelineText = named(timeline, timelineState.name);
    const sizeText = `${looked.width}×${looked.height}`;
    const where = `timeline ${timelineText} in format ${format.id} (${format.width}×${format.height})`;
    let number = 0;
    const add = (
      rendered: LookedShot["picture"],
      role: LookImageRole,
      shot: number,
      what: string,
    ): string | undefined => {
      if (!rendered) return undefined;
      number += 1;
      images.push(imageOf(rendered, role, shot, `[image ${number}: ${what}]`));
      return `image ${number}`;
    };
    const shotData: LookShotData[] = [];
    if (sheet) {
      const one = looked.shots[0];
      const label = add(
        one?.picture,
        "sheet",
        0,
        `overview of ${where}, ${times.length} frames from t=${times[0]} to t=${times.at(-1)}, left to right and top to bottom in ${columns} columns, each with its time, ${sizeText}`,
      );
      lines.push(
        `${label ? `${label}: ` : ""}overview of ${where}, ${times.length} frames, ${columns} columns, each printed with its time`,
      );
      for (const [index, t] of times.entries()) {
        const cell = measured[index] as FrameFacts;
        lines.push(cellLine(t, cell));
        shotData.push({ t, seconds: toSeconds(parseTime(t)), findings: findingsOf(cell, unit) });
      }
    } else {
      lines.push(
        `${times.length === 1 ? "the frame" : `${times.length} frames`} of ${where}, as the export renders them${args.region ? `, only region ${rectText(args.region)}` : ""}`,
      );
      for (const [index, t] of times.entries()) {
        const got = looked.shots[index] ?? {};
        const at = `t=${t}`;
        const marks =
          (shots[index] as LookShot).marks.length > 0
            ? ", with boxes and ids of clips drawn on it"
            : "";
        const region = args.region ? `, region ${rectText(args.region)}` : "";
        const labels: string[] = [];
        if (before) {
          const was = add(
            got.before,
            "before",
            index,
            `${at} before (${against}), ${sizeText}${region}`,
          );
          const now = add(got.picture, "after", index, `${at} now, ${sizeText}${region}${marks}`);
          const diff = add(
            got.diff,
            "diff",
            index,
            `${at}, what differs between before and now, changed pixels in red, ${sizeText}`,
          );
          if (was) labels.push(`${was} before`);
          if (now) labels.push(`${now} now`);
          if (diff) labels.push(`${diff} what differs`);
        } else {
          const label = add(
            got.picture,
            "frame",
            index,
            `${where} at ${at}, ${sizeText}${region}${marks}`,
          );
          if (label) labels.push(label);
        }
        if (got.clean && got.picture) {
          images.push(imageOf(got.clean, "clean", index, `[${at} without boxes]`, true));
        }
        lines.push("", `${at}${labels.length > 0 ? ` (${labels.join(", ")})` : ""}`);
        let changed: LookShotData["changed"];
        if (before && got.changed) {
          const box =
            got.changed.box && worldOfPixels(got.changed.box, looked.width, looked.height, shown);
          changed = { ratio: got.changed.ratio, ...(box && { box }) };
          lines.push(
            got.changed.ratio > 0
              ? `changed since ${against}: ${percent(got.changed.ratio)} of the pixels${box ? `, within box ${rectText(box)}` : ""}`
              : `changed since ${against}: no pixel`,
          );
        }
        const onIt = measured[index] as FrameFacts;
        const inRegion = args.region
          ? { ...onIt, clips: onIt.clips.filter((clip) => overlapOf(clip.box, shown)) }
          : onIt;
        lines.push(...factLines(inRegion));
        shotData.push({
          t,
          seconds: toSeconds(parseTime(t)),
          findings: findingsOf(inRegion, unit),
          ...(changed && { changed }),
        });
      }
      const wanted = Array.isArray(args.annotate) ? args.annotate : [];
      const missing = wanted.filter(
        (id) => !measured.some((facts) => facts.clips.some((clip) => clip.id === id)),
      );
      if (missing.length > 0) lines.push(`annotate: not on these frames: ${missing.join(", ")}`);
    }
    const sent = images.filter((image) => !image.forPeople);
    const tokens = sent.reduce((sum, image) => sum + tokensOf(image.width, image.height), 0);
    const head = [
      looked.sees
        ? `${sent.length === 1 ? "1 picture" : `${sent.length} pictures`} of ${sizeText} ${sent.length === 1 ? "comes" : "come"} before this text, about ${tokens} tokens in all`
        : "pictures not attached: this model cannot see pictures; this is what the frames have",
      `world units: the picture is x ${round(picture.x)}..${round(picture.x + picture.width)}, y ${round(picture.y)}..${round(picture.y + picture.height)}, origin at its center; a box is x,y of its top left corner and width×height`,
    ];
    const data: LookData = {
      ...base,
      sees: looked.sees,
      tokens: looked.sees ? tokens : 0,
      shots: shotData,
    };
    const result: ToolResult = answer(call, [...head, ...lines], { look: data });
    return looked.sees && images.length > 0 ? { ...result, images } : result;
  },
};
