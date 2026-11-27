import { entryOf, type ProjectState } from "@animaquill/core";
import type { Names } from "./toolSummary.ts";

/** What the project calls its objects, for the lines of tools. */
export function namesIn(state: ProjectState | undefined): Names {
  return {
    timeline: (id) => {
      const wanted = id ?? state?.manifest.timelines[0];
      return wanted === undefined || !state ? undefined : entryOf(state.timelines, wanted)?.name;
    },
    object: (id, timeline) => {
      if (!state) return undefined;
      const timelines = timeline === undefined ? Object.keys(state.timelines) : [timeline];
      for (const each of timelines) {
        const found = entryOf(state.timelines, each);
        if (!found) continue;
        const named =
          entryOf(found.clips, id) ??
          entryOf(found.tracks, id) ??
          entryOf(found.markers, id) ??
          entryOf(found.sections, id);
        if (named) return named.name;
      }
      return (
        entryOf(state.timelines, id)?.name ??
        entryOf(state.scenes, id)?.name ??
        entryOf(state.sounds, id)?.name ??
        entryOf(state.assets, id)?.name
      );
    },
  };
}
