import type { ProjectState } from "@animaquill/core";
import type { PropertySpec } from "@animaquill/schema";
import type { TimelineModel } from "../timeline/model.ts";
import {
  inspectPlace,
  inspectProperty,
  type Blocked,
  type InspectedProperty,
  type TrialLook,
} from "./inspect.ts";

/** What rows go by, as far as they need it. */
export interface RowSources {
  readonly timeline: {
    readonly model: TimelineModel | undefined;
    readonly frame: number;
    subscribe(listener: () => void): () => void;
    /** Up to once per frame while playing. */
    subscribeView(listener: () => void): () => void;
  };
  readonly trials: {
    readonly look: TrialLook | undefined;
    getSnapshot(): { readonly comparing: boolean };
    subscribe(listener: () => void): () => void;
  };
  readonly state: () => ProjectState | undefined;
}

/** Where the playhead is for a clip, as text that stays the same while that does. */
export type PlaceSignature = string;

/**
 * What each row of the properties tab looks at for itself: the playhead moves with every frame
 * while playing, and a row draws again only when what it shows changes. That keeps a clip with
 * hundreds of properties as quick as one with a few, also because only rows near the screen are
 * there to look.
 */
export class PropertyRows {
  readonly #sources: RowSources;
  /** What everything was looked up for, and what was looked up: see `#now`. */
  #moment: Moment | undefined;
  readonly #looked = new Map<string, WeakMap<PropertySpec, Looked>>();
  readonly #places = new Map<string, PlaceSignature>();

  constructor(sources: RowSources) {
    this.#sources = sources;
  }

  /** Anything that changes what rows show: the playhead, the project, what is being tried. */
  subscribe = (listener: () => void): (() => void) => {
    const { timeline, trials } = this.#sources;
    const stops = [
      timeline.subscribeView(listener),
      timeline.subscribe(listener),
      trials.subscribe(listener),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  };

  /**
   * Where everything is now. A row asks several times for each change, and each row of a clip the
   * same, so what was looked up stays until something changes.
   */
  #now(): Moment | undefined {
    const state = this.#sources.state();
    const { model, frame } = this.#sources.timeline;
    const { trials } = this.#sources;
    const tried = trials.getSnapshot();
    const { look } = trials;
    const last = this.#moment;
    const same =
      last !== undefined &&
      last.state === state &&
      last.model === model &&
      last.frame === frame &&
      last.tried === tried &&
      last.look === look;
    if (!same) {
      this.#moment = { state, model, frame, tried, look };
      this.#looked.clear();
      this.#places.clear();
    }
    return this.#moment;
  }

  /** One property of a clip at the playhead, if the clip is still there. */
  inspect(clip: string, spec: PropertySpec): InspectedProperty | undefined {
    return this.#look(clip, spec)?.inspected;
  }

  #look(clip: string, spec: PropertySpec): Looked | undefined {
    const now = this.#now();
    const box = now?.model?.boxes.get(clip);
    if (!now?.state || !now.model || !box) return undefined;
    let own = this.#looked.get(clip);
    if (!own) this.#looked.set(clip, (own = new WeakMap()));
    const known = own.get(spec);
    if (known) return known;
    const { state, model, frame, look, tried } = now;
    const view = { look, comparing: tried.comparing };
    const inspected = inspectProperty(state, model, box, spec, frame, view);
    const looked = { inspected, signature: signatureOf(inspected) };
    own.set(spec, looked);
    return looked;
  }

  /** What a row shows, as text: the same as long as nothing it shows changed. */
  signatureOf(clip: string, spec: PropertySpec): string {
    return this.#look(clip, spec)?.signature ?? "";
  }

  /** Whether a clip can change at the playhead, and where it starts: see `placeOf`. */
  placeOf(clip: string): PlaceSignature {
    const now = this.#now();
    const known = this.#places.get(clip);
    if (known !== undefined) return known;
    const box = now?.model?.boxes.get(clip);
    if (!now?.state || !now.model || !box) return "";
    const { state, model, frame, look, tried } = now;
    const place = inspectPlace(state, model, box, frame, { look, comparing: tried.comparing });
    const signature = `${place.blocked ?? ""} ${place.firstFrame}`;
    this.#places.set(clip, signature);
    return signature;
  }
}

interface Moment {
  readonly state: ProjectState | undefined;
  readonly model: TimelineModel | undefined;
  readonly frame: number;
  /** What is being tried changes with this, also where `look` stays the same object. */
  readonly tried: { readonly comparing: boolean };
  readonly look: TrialLook | undefined;
}

interface Looked {
  readonly inspected: InspectedProperty;
  readonly signature: string;
}

function signatureOf({ row, blocked }: InspectedProperty): string {
  return JSON.stringify([
    row.value,
    row.stored === undefined,
    row.automatic,
    row.animated,
    row.keyTime,
    row.previousKey,
    row.nextKey,
    row.tried,
    row.changedElsewhere,
    blocked,
  ]);
}

/** What `PropertyRows.placeOf` said, read back. */
export function placeOf(signature: PlaceSignature): {
  readonly blocked: Blocked | undefined;
  readonly firstFrame: number;
} {
  const [blocked = "", first = "0"] = signature.split(" ");
  return { blocked: blocked === "" ? undefined : (blocked as Blocked), firstFrame: Number(first) };
}
