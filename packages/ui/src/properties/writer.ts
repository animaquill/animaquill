import { CommandError, applyEdit, effectiveProperties, type PropertyEdit } from "@animaquill/core";
import type { PropertyValue } from "@animaquill/schema";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import type { TimelineEditor } from "../timeline/editor.ts";

/** What the picture shows instead of the project, by clip and then by property path. */
export type PreviewedValues = ReadonlyMap<string, ReadonlyMap<string, PropertyValue | undefined>>;

export interface PropertyWriterMessages {
  commandFailed(message: string): void;
}

const NOTHING: PreviewedValues = new Map();

/**
 * The one way from a control to a property, for whatever people turn or drag. A value that is still
 * moving only reaches the picture, and it becomes one command when it stops, so one drag is one step
 * to undo. Trying things out before keeping them goes in here.
 */
export class PropertyWriter {
  readonly #session: ProjectSession;
  readonly #timeline: TimelineEditor;
  readonly #messages: PropertyWriterMessages;
  readonly #emitter = new Emitter();
  #previewed = NOTHING;

  constructor(session: ProjectSession, timeline: TimelineEditor, messages: PropertyWriterMessages) {
    this.#session = session;
    this.#timeline = timeline;
    this.#messages = messages;
  }

  subscribe = this.#emitter.subscribe;

  getPreviewed = (): PreviewedValues => this.#previewed;

  /** Shows what these edits would do, instead of what was shown so far. */
  preview(edits: readonly PropertyEdit[]): void {
    const clips = this.#timeline.model?.state.clips;
    const previewed = new Map<string, Map<string, PropertyValue | undefined>>();
    for (const edit of edits) {
      const { path, owner } = edit;
      const clip = clips?.[owner.clip];
      if (!clip) continue;
      const values = previewed.get(clip.id) ?? new Map<string, PropertyValue | undefined>();
      previewed.set(clip.id, values);
      const before = values.has(path) ? values.get(path) : effectiveProperties(clip)[path];
      try {
        values.set(path, applyEdit(before, edit));
      } catch (error) {
        // Somebody else took that key away. The command says so if it comes to that.
        if (!(error instanceof CommandError)) throw error;
      }
    }
    this.#previewed = previewed;
    this.#emitter.emit();
  }

  /** Goes back to showing the project. */
  cancel(): void {
    if (this.#previewed.size === 0) return;
    this.#previewed = NOTHING;
    this.#emitter.emit();
  }

  /**
   * Writes edits as one step. The preview ends after that, so that what was shown is replaced by
   * the same thing from the project and the old value does not flash up in between.
   */
  commit(edits: readonly PropertyEdit[]): boolean {
    const store = this.#session.store;
    const timeline = this.#timeline.model?.id;
    let done = false;
    if (store && timeline !== undefined && edits.length > 0) {
      const result = store.execute({ type: "property.edit", params: { timeline, edits } });
      if (result.ok) done = true;
      else this.#messages.commandFailed(result.error.message);
    }
    this.cancel();
    return done;
  }
}
