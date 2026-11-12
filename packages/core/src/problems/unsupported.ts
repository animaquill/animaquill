import {
  add,
  compare,
  isAnimation,
  parseTime,
  type PropertyValue,
  type Rational,
} from "@animaquill/schema";
import {
  clipOffset,
  entryOf,
  orderedTracks,
  statedSoundLength,
  type ClipState,
  type ProjectState,
  type TimelineState,
  type TrackState,
} from "../model.ts";
import { withId, type OutputPart, type ProblemSubject, type ProjectProblem } from "./model.ts";

/**
 * What the format has and this editor does not do yet. Each is a problem as soon as a project uses
 * it in a way that would make a difference; one that makes an export otherwise than the project
 * says has `affectsOutput`, and an export stops there first. Once the editor does one of them, its
 * code goes from here, and the list in the project format goes along.
 */
export const UNSUPPORTED_CODES = [
  "unsupported-music-clip",
  "unsupported-timeline-clip",
  "unsupported-library",
  "unsupported-caption-display",
  "unsupported-audio-effect",
  "unsupported-audio-property",
  "unsupported-volume-keys",
  "unsupported-loop",
  "unsupported-draft",
  "unsupported-override",
] as const;

export type UnsupportedCode = (typeof UNSUPPORTED_CODES)[number];

/** Properties of sound that are not applied, with what they come to when nothing applies them. */
const AUDIO_PROPERTIES: Readonly<Record<string, number | boolean>> = {
  "audio.pan": 0,
  "audio.pitch": 0,
  "audio.preservePitch": false,
};

/** Kinds of clips that make sound here: the others are a problem of their own, or silent. */
const SOUNDING = new Set(["audio", "sound"]);
/** Kinds of clips that have a clock that `time.speed` would change. */
const WITH_TIME = new Set(["video", "audio", "scene", "sound", "music", "timeline"]);

/** Whether a value is something else than the default at some moment. */
function differs(value: PropertyValue | undefined, fallback: number | boolean): boolean {
  if (value === undefined) return false;
  if (isAnimation(value)) return value.keys.some((key) => key.value !== fallback);
  return value !== fallback;
}

/** Whether a value has keys that are not all the same, which is what “only the first” loses. */
function varies(value: PropertyValue | undefined): boolean {
  if (value === undefined || !isAnimation(value)) return false;
  const [first, ...rest] = value.keys;
  const plain = JSON.stringify(first?.value);
  return rest.some((key) => JSON.stringify(key.value) !== plain);
}

/** A file of a library, wherever a value has one. */
function libraryIn(value: PropertyValue | undefined): string | undefined {
  const values =
    value !== undefined && isAnimation(value) ? value.keys.map((key) => key.value) : [value];
  for (const each of values) {
    if (typeof each !== "object" || each === null || Array.isArray(each)) continue;
    const library = (each as { readonly library?: unknown }).library;
    if (typeof library === "string") return library;
  }
  return undefined;
}

/** The library that a clip takes something from, if any: its content, a value or a transition. */
function libraryOf(clip: ClipState): string | undefined {
  const { source } = clip;
  const fields = source as { readonly media?: unknown; readonly library?: unknown };
  if (typeof fields.library === "string") return fields.library;
  const media = fields.media as { readonly library?: unknown } | undefined;
  if (typeof media?.library === "string") return media.library;
  for (const edge of [clip.enter, clip.exit]) {
    if (typeof edge?.library === "string") return edge.library;
  }
  for (const value of Object.values(clip.properties ?? {})) {
    const library = libraryIn(value);
    if (library !== undefined) return library;
  }
  return undefined;
}

/** How long the content of a clip is, in its own time, when that is known. */
function lengthOf(state: ProjectState, clip: ClipState): Rational | undefined {
  const { source } = clip;
  if (source.kind === "sound") {
    const seconds = statedSoundLength(state, clip);
    return seconds === undefined ? undefined : parseTime(String(seconds));
  }
  const media = (source as { readonly media?: { readonly asset?: unknown } }).media;
  if (typeof media?.asset !== "string") return undefined;
  const duration = entryOf(state.assets, media.asset)?.info?.duration;
  if (duration === undefined) return undefined;
  try {
    return parseTime(duration);
  } catch {
    return undefined;
  }
}

/** Whether a loop would repeat anything: only when the clip goes on past the end of its content. */
function loopMatters(state: ProjectState, clip: ClipState): boolean {
  if (!clip.loop) return false;
  if (!["video", "audio", "sound"].includes(clip.source.kind)) return false;
  // A changing speed makes the end of the content another moment of the clip.
  if (differs(clip.properties?.["time.speed"], 1)) return true;
  const length = lengthOf(state, clip);
  if (length === undefined) return true;
  try {
    return compare(add(clipOffset(clip), parseTime(clip.duration)), length) > 0;
  } catch {
    return true;
  }
}

/** Which tracks are seen and heard: an export has nothing of the others, so they change nothing. */
function outputsOf(timeline: TimelineState) {
  const tracks = orderedTracks(timeline);
  const soloing = tracks.some((track) => track.kind === "audio" && track.solo === true);
  const heard = (track: TrackState) =>
    track.kind === "audio" && (soloing ? track.solo === true : track.muted !== true);
  const seen = (track: TrackState) => track.kind !== "audio" && track.hidden !== true;
  return {
    tracks,
    /** What of an export a clip is part of, or undefined when it is in none. */
    partOf(clip: ClipState): OutputPart | undefined {
      const track = timeline.tracks[clip.track];
      if (!track || clip.hidden) return undefined;
      if (seen(track)) return "picture";
      return heard(track) ? "sound" : undefined;
    },
    heard,
    seen,
  };
}

/**
 * Everything that this editor does not do and the project uses, timeline by timeline. Problems of
 * one clip go together by clip, problems of a whole track or timeline by it.
 */
export function unsupportedProblems(state: ProjectState): readonly ProjectProblem[] {
  const problems: ProjectProblem[] = [];
  const masterLanguage = state.manifest.languages[0]?.id;
  for (const [timelineId, timeline] of Object.entries(state.timelines)) {
    const { tracks, partOf, heard, seen } = outputsOf(timeline);
    const report = (
      code: UnsupportedCode,
      subject: ProblemSubject,
      params: Record<string, string | number>,
      part: OutputPart | undefined,
      place?: string,
    ) =>
      problems.push(
        withId({
          source: "unsupported",
          severity: "warning",
          code,
          params,
          subject,
          ...(place !== undefined && { place }),
          ...(part && { affectsOutput: part }),
        }),
      );
    const clipOf = (clip: ClipState): ProblemSubject => ({
      kind: "clip",
      id: clip.id,
      timeline: timelineId,
    });
    const trackOf = (track: TrackState): ProblemSubject => ({
      kind: "track",
      id: track.id,
      timeline: timelineId,
    });
    const whole: ProblemSubject = { kind: "timeline", id: timelineId };

    const captions = new Map<string, ClipState[]>();
    for (const clip of Object.values(timeline.clips)) {
      const subject = clipOf(clip);
      const part = partOf(clip);
      const kind = clip.source.kind;
      const track = timeline.tracks[clip.track];
      const sounding = track?.kind === "audio" && SOUNDING.has(kind);
      if (kind === "music") report("unsupported-music-clip", subject, {}, part);
      if (kind === "timeline") {
        const nested = (clip.source as { readonly timeline?: unknown }).timeline;
        const params = typeof nested === "string" ? { timeline: nested } : {};
        report("unsupported-timeline-clip", subject, params, part);
      }
      if (kind === "caption" && track?.kind === "caption") {
        const list = captions.get(track.id);
        if (list) list.push(clip);
        else captions.set(track.id, [clip]);
      }
      const library = libraryOf(clip);
      if (library !== undefined) report("unsupported-library", subject, { library }, part);
      if (track?.kind === "audio") {
        const effects = Object.values(clip.effects ?? {}).filter(
          (effect) => effect.type !== undefined && effect.enabled !== false,
        );
        if (effects.length > 0) {
          report(
            "unsupported-audio-effect",
            subject,
            { where: "clip", count: effects.length },
            part,
          );
        }
      }
      const properties = clip.properties ?? {};
      const speed = differs(properties["time.speed"], 1) && WITH_TIME.has(kind);
      if (speed)
        report(
          "unsupported-audio-property",
          subject,
          { property: "time.speed" },
          part,
          "time.speed",
        );
      if (sounding) {
        for (const [path, fallback] of Object.entries(AUDIO_PROPERTIES)) {
          if (!differs(properties[path], fallback)) continue;
          // Keeping the pitch only does something when the speed changes.
          const matters = path !== "audio.preservePitch" || speed;
          report(
            "unsupported-audio-property",
            subject,
            { property: path },
            matters ? part : undefined,
            path,
          );
        }
        if (varies(properties["audio.volume"])) {
          report("unsupported-volume-keys", subject, {}, part, "audio.volume");
        }
      }
      if (loopMatters(state, clip)) report("unsupported-loop", subject, {}, part);
      if (clip.draft === true) report("unsupported-draft", subject, {}, part);
    }

    for (const track of tracks) {
      const clips = captions.get(track.id);
      if (clips && clips.length > 0) {
        const shown = seen(track) && clips.some((clip) => !clip.hidden);
        report(
          "unsupported-caption-display",
          trackOf(track),
          { count: clips.length },
          shown ? "picture" : undefined,
        );
      }
      if (track.kind !== "audio") continue;
      const part = heard(track) ? "sound" : undefined;
      const effects = (track.effects ?? []).filter((effect) => effect.enabled !== false);
      if (effects.length > 0) {
        report(
          "unsupported-audio-effect",
          trackOf(track),
          { where: "track", count: effects.length },
          part,
        );
      }
      const properties = track.properties ?? {};
      for (const [path, fallback] of Object.entries(AUDIO_PROPERTIES)) {
        if (!differs(properties[path], fallback)) continue;
        const matters = path !== "audio.preservePitch";
        report(
          "unsupported-audio-property",
          trackOf(track),
          { property: path },
          matters ? part : undefined,
          path,
        );
      }
      if (varies(properties["audio.volume"])) {
        report("unsupported-volume-keys", trackOf(track), {}, part, "audio.volume");
      }
    }

    for (const join of Object.values(timeline.joins ?? {})) {
      const library = join.transition?.library;
      if (typeof library !== "string") continue;
      const from = join.from === undefined ? undefined : timeline.clips[join.from];
      const track = join.track === undefined ? undefined : timeline.tracks[join.track];
      const subject = from ? clipOf(from) : track ? trackOf(track) : whole;
      const part = from ? partOf(from) : undefined;
      report("unsupported-library", subject, { library }, part);
    }

    const { mix } = timeline;
    const buses = mix?.buses?.length ?? 0;
    const master = mix?.master;
    const mastered =
      (master?.effects ?? []).some((effect) => effect.enabled !== false) ||
      Object.keys(master?.properties ?? {}).length > 0;
    if (buses > 0 || mastered) {
      const anyHeard = tracks.some(heard);
      report(
        "unsupported-audio-effect",
        whole,
        { where: "mix", count: buses },
        anyHeard ? "sound" : undefined,
        "mix",
      );
    }

    for (const [name, version] of Object.entries(timeline.overrides)) {
      const changes =
        Object.keys(version.sections ?? {}).length + Object.keys(version.clips ?? {}).length;
      if (changes === 0) continue;
      const { language, format } = version.scope;
      const params = {
        name,
        ...(language !== undefined && { language }),
        ...(format !== undefined && { format }),
      };
      // An export is of the master language, in a format people choose: see `outputProblems`.
      const part =
        format !== undefined && (language === undefined || language === masterLanguage)
          ? "both"
          : undefined;
      report("unsupported-override", whole, params, part, name);
    }
  }
  return problems;
}
