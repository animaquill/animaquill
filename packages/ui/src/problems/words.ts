import { entryOf, orderedTracks, type ProjectProblem, type ProjectState } from "@animaquill/core";
import type { SceneProblem } from "@animaquill/scene";
import type { TFunction } from "i18next";
import { describeProblem, describeStatus, sceneClipName } from "../preview/problems.ts";

/** Text from a project is text, whatever it looks like. */
const asText = { interpolation: { escapeValue: false } } as const;

const textOf = (t: TFunction, key: string, fallback: string) =>
  t(key, { defaultValue: fallback, ...asText });

/** What a problem is about, in the words of the editor: a clip, a track, a timeline or a scene. */
export function originOf(
  t: TFunction,
  problem: ProjectProblem,
  state: ProjectState | undefined,
): string {
  const { subject, source } = problem;
  if (!subject) return t(`problems.origin.${source}`, { defaultValue: "" });
  if (subject.kind === "scene") return entryOf(state?.scenes, subject.id)?.name ?? subject.id;
  if (subject.kind === "sound") return entryOf(state?.sounds, subject.id)?.name ?? subject.id;
  const timelineId = subject.kind === "timeline" ? subject.id : (subject.timeline ?? "");
  const timeline = entryOf(state?.timelines, timelineId);
  if (subject.kind === "timeline") return timeline?.name ?? subject.id;
  if (subject.kind === "clip") {
    const clip = entryOf(timeline?.clips, subject.id);
    if (!clip) return subject.id;
    if (clip.source.kind === "scene") return sceneClipName(clip, state, t);
    const kind = clip.source.kind;
    return clip.name ?? textOf(t, `timeline.kind.${kind}`, kind);
  }
  if (subject.kind === "track") {
    const track = entryOf(timeline?.tracks, subject.id);
    if (!track) return subject.id;
    const number =
      orderedTracks(timeline as never)
        .filter(({ kind }) => kind === track.kind)
        .findIndex(({ id }) => id === track.id) + 1;
    return track.name ?? t(`timeline.track.${track.kind}`, { number });
  }
  return subject.id;
}

/** What a version is called: its language, its format, or both. */
function versionName(
  t: TFunction,
  state: ProjectState | undefined,
  problem: ProjectProblem,
): string {
  const { language, format, name } = problem.params;
  const manifest = state?.manifest;
  const parts = [
    language === undefined
      ? undefined
      : (manifest?.languages.find(({ id }) => id === language)?.name ?? language),
    format === undefined
      ? undefined
      : (manifest?.formats.find(({ id }) => id === format)?.name ?? format),
  ].filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join(t("problems.versionSeparator")) : String(name);
}

/** The words of the parameters, where a parameter is a name of something else. */
function wordsOf(
  t: TFunction,
  problem: ProjectProblem,
  state: ProjectState | undefined,
): Record<string, unknown> {
  const { code, params } = problem;
  switch (code) {
    case "property-mismatch":
      return {
        ...params,
        type: textOf(t, `problems.properties.types.${params["type"]}`, String(params["type"])),
      };
    case "unsupported-audio-property": {
      const property = String(params["property"]);
      return {
        property: textOf(t, `problems.audioProperty.${property.replace(".", "-")}`, property),
      };
    }
    case "unsupported-timeline-clip": {
      const nested = entryOf(state?.timelines, String(params["timeline"] ?? ""));
      return { timeline: nested?.name ?? params["timeline"] ?? "" };
    }
    case "unsupported-override":
      return { version: versionName(t, state, problem) };
    default:
      return params;
  }
}

/** A problem of the code of a scene, as the scene said it, without where it is. */
function sceneProblemOf(problem: ProjectProblem): SceneProblem {
  const { params, detail } = problem;
  const code = params["code"];
  const target = params["target"];
  return {
    kind: problem.code.slice("scene-".length) as SceneProblem["kind"],
    frame: 0,
    ...(typeof code === "string" && { code }),
    ...(detail !== undefined && { message: detail }),
    ...(typeof target === "string" && { target }),
    ...(problem.file !== undefined && { file: problem.file }),
  };
}

/** The kinds of problems that code of a scene has when it runs, by their code. */
export const SCENE_RUNTIME_CODES = new Set([
  "scene-error",
  "scene-rejection",
  "scene-resource",
  "scene-blocked",
  "scene-loader",
  "scene-api",
]);

/** What a problem says, in words: by its code and parameters, or as a host said it. */
export function describeProjectProblem(
  t: TFunction,
  problem: ProjectProblem,
  state: ProjectState | undefined,
  origin: string,
): string {
  const { code, params, detail } = problem;
  if (SCENE_RUNTIME_CODES.has(code)) return describeProblem(t, sceneProblemOf(problem));
  if (code === "scene-stopped") {
    const status = {
      state: params["state"] as never,
      ...(typeof params["reason"] === "string" && { reason: params["reason"] as never }),
      ...(detail !== undefined && { message: detail }),
    };
    return describeStatus(t, origin, status as never);
  }
  if (code === "scene-registration") {
    const target = params["target"] ?? "";
    return t(`scene.problems.codes.${params["problem"]}`, {
      target,
      defaultValue: code,
      ...asText,
    });
  }
  if (code === "unsupported-audio-effect") {
    const key = `problems.codes.unsupported-audio-effect.${params["where"]}`;
    return t(key, { ...params, defaultValue: code, ...asText });
  }
  const key = `problems.codes.${code}`;
  return t(key, {
    ...wordsOf(t, problem, state),
    ...asText,
    // What a host says in its own words has no code of the editor.
    defaultValue: detail ?? code,
  });
}
