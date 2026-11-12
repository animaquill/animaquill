import { toSeconds } from "@animaquill/schema";
import { clipEnd, clipStart, entryOf, type ProjectState } from "../model.ts";
import { compareProblems, type ProjectProblem } from "./model.ts";
import { propertyProblems, type PropertyInputs } from "./properties.ts";
import { referenceProblems } from "./references.ts";
import { unsupportedProblems } from "./unsupported.ts";

export interface StaticInputs {
  /** With it, what clips hold for their scenes is checked too (the editor has it, a command line not). */
  readonly describe?: PropertyInputs["describe"];
  readonly registered?: PropertyInputs["registered"];
}

/** What can be told from the project alone. The same project gives the same problems, anywhere. */
export function staticProblems(
  state: ProjectState,
  inputs: StaticInputs = {},
): readonly ProjectProblem[] {
  const { describe, registered } = inputs;
  const properties = describe
    ? Object.keys(state.timelines).flatMap((timeline) =>
        propertyProblems(state, timeline, { describe, ...(registered && { registered }) }),
      )
    : [];
  return [...referenceProblems(state), ...unsupportedProblems(state), ...properties].toSorted(
    compareProblems,
  );
}

/** What an export makes. */
export interface OutputQuery {
  readonly timeline: string;
  /** Without one, the first. */
  readonly format?: string;
  /** A picture has no sound. */
  readonly part: "picture" | "both";
  /** In seconds of the timeline. A still is one moment: `from` and `to` the same. */
  readonly from?: number;
  readonly to?: number;
}

/**
 * The problems that make this export otherwise than the project says: of its timeline, of what it
 * has (a picture has no sound), within its time, and a version only when it is the one exported.
 */
export function outputProblems(
  state: ProjectState,
  problems: readonly ProjectProblem[],
  query: OutputQuery,
): readonly ProjectProblem[] {
  const timeline = entryOf(state.timelines, query.timeline);
  if (!timeline) return [];
  const format = query.format ?? state.manifest.formats[0]?.id;
  const { from = 0, to = Number.POSITIVE_INFINITY } = query;
  /** A clip is in the export when it shows at a moment of it: at the moment, for a still. */
  const within = (clip: string) => {
    const found = timeline.clips[clip];
    if (!found) return false;
    try {
      const start = toSeconds(clipStart(found));
      const end = toSeconds(clipEnd(found));
      return from === to ? start <= from && from < end : start < to && end > from;
    } catch {
      return true;
    }
  };
  return problems.filter((problem) => {
    const { affectsOutput, subject, code, params } = problem;
    if (!affectsOutput || !subject) return false;
    if (query.part === "picture" && affectsOutput === "sound") return false;
    const of = subject.kind === "timeline" ? subject.id : subject.timeline;
    if (of !== query.timeline) return false;
    if (code === "unsupported-override") return params["format"] === format;
    if (subject.kind === "clip") return within(subject.id);
    if (code === "unsupported-caption-display") {
      return Object.values(timeline.clips).some(
        (clip) => clip.track === subject.id && !clip.hidden && within(clip.id),
      );
    }
    return true;
  });
}
