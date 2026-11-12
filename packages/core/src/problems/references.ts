import type { ProjectState } from "../model.ts";
import { missingIn } from "../uses.ts";
import { withId, type ProjectProblem } from "./model.ts";

/**
 * Clips that use an asset, scene or sound that the project does not have: a clip pasted from another
 * project, a file written elsewhere or two people at once can do that. The clip shows or plays
 * nothing of it. What libraries, effects and transitions that are not there do is told elsewhere:
 * libraries by `unsupported-library`, the others where they are used.
 */
export const REFERENCE_CODES = ["asset-missing", "scene-missing", "sound-missing"] as const;

export type ReferenceCode = (typeof REFERENCE_CODES)[number];

/** A problem for each clip, and each version of one, that uses what is not there. */
export function referenceProblems(state: ProjectState): readonly ProjectProblem[] {
  const problems: ProjectProblem[] = [];
  for (const missing of missingIn(state)) {
    if (missing.kind !== "asset" && missing.kind !== "scene" && missing.kind !== "sound") continue;
    const { kind, id } = missing;
    for (const use of missing.uses) {
      if (use.clip === undefined) continue;
      problems.push(
        withId({
          source: "reference",
          severity: "warning",
          code: `${kind}-missing` satisfies ReferenceCode,
          params: { [kind]: id, ...(use.version !== undefined && { version: use.version }) },
          subject: { kind: "clip", id: use.clip, timeline: use.timeline },
        }),
      );
    }
  }
  return problems;
}
