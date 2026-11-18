import {
  CommandError,
  applyEdit,
  clipStart,
  editContextOf,
  effectiveProperties,
  entryOf,
  hasAutoTangents,
  objectsOf,
  valueWithout,
  withAutoTangents,
  type ClipDescription,
  type ClipState,
  type ClipPropertyEdit,
  type CommandFailure,
} from "@animaquill/core";
import {
  BUILT_IN_PROPERTIES,
  isAnimation,
  parseTime,
  subtract,
  toSeconds,
  type Key,
  type ObjectDescriptor,
  type PropertySpec,
  type PropertyValue,
  type Value,
} from "@animaquill/schema";
import { Emitter } from "../workbench/emitter.ts";
import type { ProjectSession } from "../workbench/session.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import type { PreviewedValues, TrialSession } from "./trial.ts";

export type { PreviewedValues } from "./trial.ts";

export interface PropertyWriterMessages {
  commandFailed(failure: CommandFailure): void;
  /** Nothing gets written while people compare with what is saved. */
  comparing(): void;
}

const NOTHING: PreviewedValues = new Map();

/**
 * Whether keys on a property do something in this version. The pitch of sound and the speed of a
 * clip take only one value yet (see the problems of the project), so recording writes them as
 * values; the volume and the pan of sound take keys.
 */
export const keysTakeEffect = (path: string): boolean =>
  (!path.startsWith("audio.") || path === "audio.volume" || path === "audio.pan") &&
  path !== "time.speed";

/** Where a property is described, among the objects of a clip. */
function specIn(objects: readonly ObjectDescriptor[], path: string): PropertySpec | undefined {
  for (const object of objects) {
    const spec = object.properties.find((one) => one.path === path);
    if (spec) return spec;
  }
  return undefined;
}

/** Whether an edit can bring in keys whose handles the editor works out. */
const bringsAutoKeys = (edit: ClipPropertyEdit) =>
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
  readonly #describe: ((clip: ClipState) => ClipDescription | undefined) | undefined;
  readonly #emitter = new Emitter();
  readonly #recordingEmitter = new Emitter();
  #recording = false;
  #dragged = NOTHING;
  #previewed = NOTHING;
  #lastProperty: { readonly clip: string; readonly spec: PropertySpec } | undefined;

  constructor(
    session: ProjectSession,
    timeline: TimelineEditor,
    trials: TrialSession,
    messages: PropertyWriterMessages,
    /** What clips offer beyond what the editor knows by itself, for the value a property starts from. */
    describe?: (clip: ClipState) => ClipDescription | undefined,
  ) {
    this.#session = session;
    this.#timeline = timeline;
    this.#trials = trials;
    this.#messages = messages;
    this.#describe = describe;
    // Another project starts without recording, as a new window does: nobody meant keys there yet.
    let store = session.store;
    session.subscribe(() => {
      if (session.store === store) return;
      store = session.store;
      this.setRecording(false);
    });
    trials.subscribe(this.#refresh);
    // A key for keyframes is about what is selected: another selection forgets the property.
    timeline.subscribe(() => {
      const last = this.#lastProperty;
      if (last && !timeline.getSnapshot().selection.has(last.clip)) this.#lastProperty = undefined;
    });
  }

  subscribe = this.#emitter.subscribe;

  /**
   * Automatic keys: while this is on, a change to a property without keys animates it, from what it
   * was at the first frame of its clip to what it is now at the playhead. It belongs to this window
   * and starts off every time, since forgetting that it is on costs more than turning it on again.
   */
  getRecording = (): boolean => this.#recording;

  subscribeRecording = this.#recordingEmitter.subscribe;

  setRecording(on: boolean): void {
    if (on === this.#recording) return;
    this.#recording = on;
    this.#recordingEmitter.emit();
  }

  toggleRecording(): void {
    this.setRecording(!this.#recording);
  }

  getPreviewed = (): PreviewedValues => this.#previewed;

  /** Takes note of the property people work with, in the properties or the keyframes. */
  noteProperty(clip: string, spec: PropertySpec): void {
    this.#lastProperty = { clip, spec };
  }

  /** The property people worked with last, which a key for keyframes is about. */
  get lastProperty(): { readonly clip: string; readonly spec: PropertySpec } | undefined {
    return this.#lastProperty;
  }

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

  #contextOf(clip: ClipState, path: string) {
    return editContextOf(this.#session.store?.getState(), clip, path);
  }

  /** Shows what these edits would do, instead of what they showed so far. */
  preview(asked: readonly ClipPropertyEdit[]): void {
    const edits = this.recorded(asked);
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
        values.set(path, applyEdit(before, edit, this.#contextOf(clip, path)));
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
  #autoEdits(edits: readonly ClipPropertyEdit[]): readonly ClipPropertyEdit[] {
    const clips = this.#timeline.model?.state.clips;
    const byProperty = new Map<string, ClipPropertyEdit[]>();
    for (const edit of edits) {
      const id = `${edit.owner.clip} ${edit.path}`;
      const own = byProperty.get(id);
      if (own) own.push(edit);
      else byProperty.set(id, [edit]);
    }
    const extra: ClipPropertyEdit[] = [];
    for (const own of byProperty.values()) {
      const [{ owner, path }] = own as [ClipPropertyEdit];
      const clip = clips?.[owner.clip];
      if (!clip) continue;
      const before = this.#shown(clip, path);
      if (!hasAutoTangents(before) && !own.some(bringsAutoKeys)) continue;
      let after = before;
      try {
        for (const edit of own) after = applyEdit(after, edit, this.#contextOf(clip, path));
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
        continue;
      }
      const keys = autoKeysOf(after);
      if (keys.length > 0) extra.push({ owner, path, op: "putKeys", keys });
    }
    return extra;
  }

  /**
   * What edits come to while recording: a value written to a property without keys becomes a key at
   * the playhead, and one at the first frame of the clip with what was there, unless that is where the
   * playhead is. Everything else, and everything while not recording, stays exactly as asked.
   */
  recorded(edits: readonly ClipPropertyEdit[]): readonly ClipPropertyEdit[] {
    if (!this.#recording || !edits.some(({ op }) => op === "write")) return edits;
    const clips = this.#timeline.model?.state.clips;
    // What a property has come to so far in these edits, as one can write it twice.
    const sofar = new Map<string, PropertyValue | undefined>();
    const recorded: ClipPropertyEdit[] = [];
    for (const edit of edits) {
      const { owner, path } = edit;
      const clip = clips?.[owner.clip];
      if (!clip) {
        recorded.push(edit);
        continue;
      }
      const id = `${clip.id} ${path}`;
      const before = sofar.has(id) ? sofar.get(id) : this.#shown(clip, path);
      const own =
        edit.op === "write" &&
        keysTakeEffect(path) &&
        !(before !== undefined && isAnimation(before))
          ? this.#firstKeys(clip, edit, before)
          : [edit];
      recorded.push(...own);
      let after = before;
      try {
        for (const one of own) after = applyEdit(after, one, this.#contextOf(clip, path));
      } catch (error) {
        if (!(error instanceof CommandError)) throw error;
      }
      sofar.set(id, after);
    }
    return recorded;
  }

  /** The keys a value written to a property without keys comes to while recording. */
  #firstKeys(
    clip: ClipState,
    edit: Extract<ClipPropertyEdit, { op: "write" }>,
    before: PropertyValue | undefined,
  ): readonly ClipPropertyEdit[] {
    const { owner, path, time, value } = edit;
    const was = before ?? this.#valueWithout(clip, path);
    // Nothing changes, as when a box that follows its media gets the size it has: no animation.
    if (was !== undefined && JSON.stringify(was) === JSON.stringify(value)) return [edit];
    const atPlayhead: ClipPropertyEdit = { owner, path, op: "setKey", time, value };
    const first = clip.offset ?? "0";
    // The first frame of a clip that does not start on a frame comes a little after its start.
    const rate = this.#timeline.model?.rate.fps;
    const after = toSeconds(subtract(parseTime(time), parseTime(first)));
    const onFirstFrame = rate === undefined ? after === 0 : after < 1 / rate - 1e-9;
    if (was === undefined || onFirstFrame) return [atPlayhead];
    return [{ owner, path, op: "setKey", time: first, value: was as Value }, atPlayhead];
  }

  /** What a property without a value of its own comes to: its default, or what it follows. */
  #valueWithout(clip: ClipState, path: string): Value | undefined {
    const state = this.#session.store?.getState();
    if (!state) return undefined;
    const spec =
      specIn(this.#describe?.(clip)?.objects ?? objectsOf(clip), path) ?? BUILT_IN_PROPERTIES[path];
    return spec && valueWithout(state, clip, spec, toSeconds(clipStart(clip)));
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
  commit(edits: readonly ClipPropertyEdit[]): boolean {
    // What people see then is what is saved, which an edit would go on top of. Controls know that,
    // and this is for whatever comes along that does not.
    if (this.#trials.getSnapshot().comparing) {
      this.#messages.comparing();
      this.cancel();
      return false;
    }
    const recorded = this.recorded(edits);
    const all = [...recorded, ...this.#autoEdits(recorded)];
    const done = this.#trials.takesEdits ? this.#trials.write(all) : this.#writeNow(all);
    this.cancel();
    return done;
  }

  #writeNow(edits: readonly ClipPropertyEdit[]): boolean {
    const store = this.#session.store;
    const timeline = this.#timeline.model?.id;
    if (!store || timeline === undefined || edits.length === 0) return false;
    const result = store.execute({ type: "property.edit", params: { timeline, edits } });
    if (!result.ok) this.#messages.commandFailed(result.error);
    return result.ok;
  }
}
