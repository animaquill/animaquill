import { Draft } from "./draft.ts";
import type { ProjectState } from "./model.ts";
import { objectOfPath, pathOfObject } from "./object-of-path.ts";
import { getIn, type Patch } from "./patch.ts";
import { isFlat, type Path } from "./structure.ts";

/**
 * What the changes of an origin, an AI task or a batch of files, were about, see
 * `ProjectStore.beforeAfterOf`: the project as it is now, with the places they wrote holding what
 * was there before them, and what they wrote. Everything else is as it is now.
 */
export interface BeforeAfter {
  readonly before: ProjectState;
  readonly after: ProjectState;
}

/** One step of an undo log: what it wrote, and what takes that back. */
interface LoggedStep {
  readonly patch: Patch;
  readonly inverse: Patch;
}

interface LoggedEntry {
  readonly steps: readonly LoggedStep[];
}

const startsWith = (path: Path, start: Path) =>
  start.length <= path.length && start.every((key, index) => path[index] === key);

/**
 * Whether a change has a place in a project: what it is part of, a clip, a timeline, is there, or
 * it is that thing itself. Another one took it away since: writing into it would make up a clip of
 * a field or two, which nobody ever had. An object that sits flat, as a join, is its fields, which
 * come one by one.
 */
function hasPlace(state: ProjectState, path: Path): boolean {
  const object = pathOfObject(objectOfPath(path));
  if (path.length > object.length && startsWith(path, object) && !isFlat(object)) {
    return getIn(state, object) !== undefined;
  }
  // What a version of a timeline changes, which is in the timeline and not in the clip.
  if (path[0] === "timelines" && path.length > 2) {
    return getIn(state, path.slice(0, 2)) !== undefined;
  }
  return true;
}

/**
 * A project with these changes written, the way the document writes them (see `Draft.repeat`),
 * apart from those that have no place in it any more, see `hasPlace`.
 */
export function patchedState(state: ProjectState, patches: readonly Patch[]): ProjectState {
  const draft = new Draft(state, "");
  for (const patch of patches) {
    if (hasPlace(draft.state, patch.path)) draft.repeat(patch);
  }
  return draft.state;
}

/**
 * Before and after the changes of an undo log, from the project as it is now. What is done wrote
 * `patch` and goes back with `inverse`; what was taken back wrote the `inverse` of what it took back
 * as its own `patch`, last step first, and the latest of it was the first taken back. So the steps
 * in the order they first happened are the done ones, then the undone ones from the last to the
 * first, each turned around. Replaying all of them from now gives what they wrote; taking all of them
 * back, the last first, what was there before. Neither depends on whether they are done now.
 */
export function beforeAfter(
  state: ProjectState,
  done: readonly LoggedEntry[],
  undone: readonly LoggedEntry[],
): BeforeAfter {
  const forward: Patch[] = [];
  const back: Patch[] = [];
  for (const { steps } of done) {
    for (const { patch, inverse } of steps) {
      forward.push(patch);
      back.push(inverse);
    }
  }
  for (const { steps } of undone.toReversed()) {
    for (const { patch, inverse } of steps.toReversed()) {
      forward.push(inverse);
      back.push(patch);
    }
  }
  return {
    before: patchedState(state, back.toReversed()),
    after: patchedState(state, forward),
  };
}
