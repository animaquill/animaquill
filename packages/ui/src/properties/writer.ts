import {
  CommandError,
  applyEdit,
  effectiveProperties,
  entryOf,
  type ClipState,
  type PropertyEdit,
} from "@animaquill/core";
import type { PropertyValue } from "@animaquill/schema";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import type { PreviewedValues, TrialSession } from "./trial.ts";

export type { PreviewedValues } from "./trial.ts";

export interface PropertyWriterMessages {
  commandFailed(message: string): void;
}

const NOTHING: PreviewedValues = new Map();

/** What a drag shows, on top of what is being tried. */
function withDragged(tried: PreviewedValues, dragged: PreviewedValues): PreviewedValues {
  const values = new Map(tried);
  for (const [clip, moving] of dragged) {
    values.set(clip, new Map([...(tried.get(clip) ?? []), ...moving]));
  }
  return values;
}

/**
 * The one way from a control to a property, for whatever people turn or drag. A value that is still
 * moving only reaches the picture, and it becomes one step when it stops, so one drag is one step to
 * undo. That step goes to what people are trying out, or straight into the project when they do not
 * want to try things first.
 */
export class PropertyWriter {
  readonly #session: ProjectSession;
  readonly #timeline: TimelineEditor;
  readonly #trials: TrialSession;
  readonly #messages: PropertyWriterMessages;
  readonly #emitter = new Emitter();
  #dragged = NOTHING;
  #previewed = NOTHING;

  constructor(
    session: ProjectSession,
    timeline: TimelineEditor,
    trials: TrialSession,
    messages: PropertyWriterMessages,
  ) {
    this.#session = session;
    this.#timeline = timeline;
    this.#trials = trials;
    this.#messages = messages;
    trials.subscribe(this.#refresh);
  }

  subscribe = this.#emitter.subscribe;

  getPreviewed = (): PreviewedValues => this.#previewed;

  #refresh = (): void => {
    const tried = this.#trials.getValues();
    const previewed = this.#dragged.size === 0 ? tried : withDragged(tried, this.#dragged);
    if (previewed === this.#previewed) return;
    this.#previewed = previewed;
    this.#emitter.emit();
  };

  /** What an edit starts from: the value people see. */
  #shown(clip: ClipState, path: string): PropertyValue | undefined {
    return entryOf(effectiveProperties(this.#trials.look?.apply(clip) ?? clip), path);
  }

  /** Shows what these edits would do, instead of what they showed so far. */
  preview(edits: readonly PropertyEdit[]): void {
    const clips = this.#timeline.model?.state.clips;
    const previewed = new Map<string, Map<string, PropertyValue | undefined>>();
    for (const edit of edits) {
      const { path, owner } = edit;
      const clip = clips?.[owner.clip];
      if (!clip) continue;
      const values = previewed.get(clip.id) ?? new Map<string, PropertyValue | undefined>();
      previewed.set(clip.id, values);
      const before = values.has(path) ? values.get(path) : this.#shown(clip, path);
      try {
        values.set(path, applyEdit(before, edit));
      } catch (error) {
        // Somebody else took that key away. The command says so if it comes to that.
        if (!(error instanceof CommandError)) throw error;
      }
    }
    this.#dragged = previewed;
    this.#refresh();
  }

  /** Goes back to showing what was there before the drag. */
  cancel(): void {
    if (this.#dragged.size === 0) return;
    this.#dragged = NOTHING;
    this.#refresh();
  }

  /**
   * Makes edits one step. The preview ends after that, so that what was shown is replaced by the
   * same thing and the old value does not flash up in between.
   */
  commit(edits: readonly PropertyEdit[]): boolean {
    const done = this.#trials.takesEdits ? this.#trials.write(edits) : this.#writeNow(edits);
    this.cancel();
    return done;
  }

  #writeNow(edits: readonly PropertyEdit[]): boolean {
    const store = this.#session.store;
    const timeline = this.#timeline.model?.id;
    if (!store || timeline === undefined || edits.length === 0) return false;
    const result = store.execute({ type: "property.edit", params: { timeline, edits } });
    if (!result.ok) this.#messages.commandFailed(result.error.message);
    return result.ok;
  }
}
