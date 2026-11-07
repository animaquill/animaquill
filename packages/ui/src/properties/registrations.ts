import {
  describeClip,
  readRegistration,
  type ClipDescription,
  type ClipState,
  type ProjectState,
  type Registration,
  type RegistrationProblem,
  type SceneRegistry,
} from "@animaquill/core";
import type { WorkCache } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/** As many states of scenes as people go through in a while. Each one is small. */
const MAX_KNOWN = 200;
/** What the cache holds goes by this, so that another shape of it later is no mistake. */
const CACHE_VERSION = 1;

interface Known {
  readonly registration: Registration;
  /** What did not make sense in what the scene said, which only matters until it runs again. */
  readonly problems: readonly RegistrationProblem[];
  /** For telling a registration that is the same from one that changed. */
  readonly text: string;
}

const keyOf = (project: string, revision: string) => `scene-objects ${project} ${revision}`;

/**
 * What the code of scenes registered when it ran, by the state of the scene it came from. None of
 * it is in the project: it comes from running the code, see `describeClip`. It is kept on this device
 * by the revision of the scene, so that a project shows its objects before its scenes run again.
 * Everything comes from where nothing is trusted, also what the cache gives back, so all of it goes
 * through `readRegistration`.
 */
export class SceneRegistrations implements SceneRegistry {
  readonly #cache: WorkCache | undefined;
  readonly #emitter = new Emitter();
  readonly #known = new Map<string, Known>();
  /** What was looked for in the cache, for this project. */
  readonly #asked = new Set<string>();
  #project: string | undefined;
  #version = 0;

  constructor(cache?: WorkCache) {
    this.#cache = cache;
  }

  subscribe = this.#emitter.subscribe;

  /** Goes up with every change, for whoever has to look again. */
  getVersion = (): number => this.#version;

  #changed(): void {
    this.#version += 1;
    this.#emitter.emit();
  }

  /** Another project: what it registered is its own. */
  open(project: string | undefined): void {
    if (project === this.#project) return;
    this.#project = project;
    this.#known.clear();
    this.#asked.clear();
    this.#changed();
  }

  registrationOf(revision: string): Registration | undefined {
    const known = this.#known.get(revision);
    if (known) return known.registration;
    this.#lookUp(revision);
    return undefined;
  }

  problemsOf(revision: string): readonly RegistrationProblem[] {
    return this.#known.get(revision)?.problems ?? [];
  }

  /** What a scene in this state of it said about itself, as it came. */
  note(revision: string, raw: unknown): void {
    const read = readRegistration(raw);
    if (!read) return;
    const text = JSON.stringify(read.registration);
    if (this.#known.get(revision)?.text === text) return;
    this.#keep(revision, { ...read, text });
    const project = this.#project;
    if (project === undefined || !this.#cache) return;
    void this.#cache.write(keyOf(project, revision), {
      version: CACHE_VERSION,
      registration: read.registration,
    });
  }

  #keep(revision: string, known: Known): void {
    this.#known.delete(revision);
    this.#known.set(revision, known);
    for (const oldest of this.#known.keys()) {
      if (this.#known.size <= MAX_KNOWN) break;
      this.#known.delete(oldest);
    }
    this.#changed();
  }

  #lookUp(revision: string): void {
    const project = this.#project;
    if (!this.#cache || project === undefined || this.#asked.has(revision)) return;
    this.#asked.add(revision);
    void this.#cache.read(keyOf(project, revision)).then((kept) => {
      if (this.#project !== project || this.#known.has(revision)) return;
      const { version, registration } = (kept ?? {}) as {
        version?: unknown;
        registration?: unknown;
      };
      const read = version === CACHE_VERSION ? readRegistration(registration) : undefined;
      if (read) this.#keep(revision, { ...read, text: JSON.stringify(read.registration) });
    });
  }
}

const sameList = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined) =>
  a === b ||
  (a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]));

const sameRenames = (a: ClipDescription["renames"], b: ClipDescription["renames"]) =>
  sameList(
    a?.map(({ from, to }) => `${from} ${to}`),
    b?.map(({ from, to }) => `${from} ${to}`),
  );

const same = (a: ClipDescription, b: ClipDescription) =>
  a.ran === b.ran && sameList(a.objects, b.objects) && sameRenames(a.renames, b.renames);

/**
 * What describes each clip, which stays the same object for as long as it says the same. The list of
 * properties goes by that: a timeline of thousands of clips only works out what changed.
 */
export class ClipDescriptions {
  readonly #registry: SceneRegistrations;
  readonly #described = new WeakMap<
    ClipState,
    { readonly version: number; readonly state: ProjectState; readonly described: ClipDescription }
  >();

  constructor(registry: SceneRegistrations) {
    this.#registry = registry;
  }

  describe(state: ProjectState, clip: ClipState): ClipDescription {
    const known = this.#described.get(clip);
    const isScene = clip.source.kind === "scene";
    const version = this.#registry.getVersion();
    // Only a scene depends on more than the clip: on its code, its parameters and what it registered.
    if (known && (!isScene || (known.version === version && known.state === state))) {
      return known.described;
    }
    const fresh = describeClip(state, clip, this.#registry);
    const described = known && same(known.described, fresh) ? known.described : fresh;
    this.#described.set(clip, { version, state, described });
    return described;
  }
}
