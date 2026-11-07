import {
  CommandError,
  applyEdit,
  effectiveProperties,
  entryOf,
  hasAutoTangents,
  withAutoTangents,
  type ClipState,
  type PropertyEdit,
} from "@animaquill/core";
import { isAnimation, type Key, type PropertyValue } from "@animaquill/schema";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import type { PreviewedValues, TrialSession } from "./trial.ts";

export type { PreviewedValues } from "./trial.ts";

export interface PropertyWriterMessages {
  commandFailed(message: string): void;
  /** Nothing gets written while people compare with what is saved. */
  comparing(): void;
}

const NOTHING: PreviewedValues = new Map();

/** Whether an edit can bring in keys whose handles the editor works out. */
const bringsAutoKeys = (edit: PropertyEdit) =>
  (edit.op === "putKeys" && edit.keys.some((key) => key.tangent === "auto")) ||
  (edit.op === "set" && hasAutoTangents(edit.value));

/** A value with the handles of its automatic keys worked out, as they have to be after a change. */
const withAuto = (value: PropertyValue | undefined) =>
  value !== undefined && isAnimation(value) ? withAutoTangents(value) : value;

/** The keys whose handles come out differently once they are worked out again. */
function autoKeysOf(value: PropertyValue | undefined): Key[] {
  if (value === undefined || !isAnimation(value)) return [];
  const worked = withAutoTangents(value);
  return worked === value ? [] : worked.keys.filter((key, index) => key !== value.keys[index]);
}

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
    // Automatic handles follow what moved around them, as they do once this is written.
    for (const values of previewed.values()) {
      for (const [path, value] of values) {
        const worked = withAuto(value);
        if (worked !== value) values.set(path, worked);
      }
    }
    this.#dragged = previewed;
    this.#refresh();
  }

  /**
   * What works out the handles of automatic keys again after some edits: the editor keeps them
   * smooth, whatever changed around them. Only properties that have such keys cost anything.
   */
  #autoEdits(edits: readonly PropertyEdit[]): readonly PropertyEdit[] {
    const clips = this.#timeline.model?.state.clips;
    const byProperty = new Map<string, PropertyEdit[]>();
    for (const edit of edits) {
      const id = `${edit.owner.clip} ${edit.path}`;
      const own = byProperty.get(id);
      if (own) own.push(edit);
      else byProperty.set(id, [edit]);
    }
    const extra: PropertyEdit[] = [];
    for (const own of byProperty.values()) {
      const [{ owner, path }] = own as [PropertyEdit];
      const clip = clips?.[owner.clip];
      if (!clip) continue;
      const before = this.#shown(clip, path);
      if (!hasAutoTangents(before) && !own.some(bringsAutoKeys)) continue;
      let after = before;
      try {
        for (const edit of own) after = applyEdit(after, edit);
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        continue;
      }
      const keys = autoKeysOf(after);
      if (keys.length > 0) extra.push({ owner, path, op: "putKeys", keys });
    }
    return extra;
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
    // What people see then is what is saved, which an edit would go on top of. Controls know that,
    // and this is for whatever comes along that does not.
    if (this.#trials.getSnapshot().comparing) {
      this.#messages.comparing();
      this.cancel();
      return false;
    }
    const all = [...edits, ...this.#autoEdits(edits)];
    const done = this.#trials.takesEdits ? this.#trials.write(all) : this.#writeNow(all);
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
