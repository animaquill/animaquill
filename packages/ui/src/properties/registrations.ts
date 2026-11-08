import {
  describeClip,
  readRegistration,
  readRegistrationText,
  type ClipDescription,
  type ClipState,
  type FoundRegistration,
  type ProjectState,
  type ReadRegistration,
  type Registration,
  type RegistrationProblem,
  type SceneRegistry,
} from "@animaquill/core";
import type { WorkCache } from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/** As many states of scenes as people go through in a while. Each one is small. */
const MAX_REVISIONS = 200;
/** Runs of one state with other parameters, which only some scenes have. Newest last. */
const MAX_RUNS = 8;
/** What the cache holds goes by this, so that another shape of it later is no mistake. */
const CACHE_VERSION = 2;

interface Known {
  readonly registration: Registration;
  /** What did not make sense in what the scene said, which only matters until it runs again. */
  readonly problems: readonly RegistrationProblem[];
  /** For telling a registration that is the same from one that changed. */
  readonly text: string;
}

const keyOf = (project: string, revision: string) => `scene-objects ${project} ${revision}`;

/** Which parameters a registration went by, and what they held, as one text. */
const paramsKeyOf = ({ params }: Registration) =>
  JSON.stringify(Object.entries(params).toSorted(([a], [b]) => (a < b ? -1 : 1)));

const knownOf = (read: ReadRegistration): Known => ({
  ...read,
  text: JSON.stringify(read.registration),
});

/** What travels as JSON, and what the cache kept, which was read the same way when it came. */
const readAny = (raw: unknown) =>
  typeof raw === "string" ? readRegistrationText(raw) : readRegistration(raw);

/**
 * What the code of scenes registered when it ran, by the state of the scene it came from and by the
 * parameters its code read on the way: what code registers can depend on those, so two clips of one
 * scene can have different objects. None of it is in the project: it comes from running the code,
 * see `describeClip`. It is kept on this device, so that a project shows its objects before its
 * scenes run again. Everything comes from where nothing is trusted, also what the cache gives back,
 * so all of it goes through `readRegistration`.
 */
export class SceneRegistrations implements SceneRegistry {
  readonly #cache: WorkCache | undefined;
  readonly #emitter = new Emitter();
  /** By revision, and then by the parameters that a run went by. */
  readonly #known = new Map<string, Map<string, Known>>();
  /** What the cache had for a revision, once it is there, for this project. */
  readonly #loaded = new Map<string, Promise<void>>();
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
    this.#loaded.clear();
    this.#changed();
  }

  registrationOf(
    revision: string,
    paramOf: (path: string) => string,
  ): FoundRegistration | undefined {
    void this.#load(revision);
    const runs = this.#known.get(revision);
    if (!runs) return undefined;
    let latest: Known | undefined;
    let fitting: Known | undefined;
    for (const known of runs.values()) {
      latest = known;
      const params = Object.entries(known.registration.params);
      if (params.every(([path, text]) => paramOf(path) === text)) fitting = known;
    }
    if (fitting) return { registration: fitting.registration, exact: true };
    return latest && { registration: latest.registration, exact: false };
  }

  /** What did not make sense in what the latest run of a state of a scene said. */
  problemsOf(revision: string): readonly RegistrationProblem[] {
    return [...(this.#known.get(revision)?.values() ?? [])].at(-1)?.problems ?? [];
  }

  /**
   * What a scene in this state of it said about itself, as it came. Gives what it goes by, to say
   * later that it is not all there is any more, see `unsure`.
   */
  note(revision: string, raw: unknown): string | undefined {
    const read = readAny(raw);
    if (!read) return undefined;
    const params = paramsKeyOf(read.registration);
    const known = knownOf(read);
    const runs = this.#known.get(revision);
    if (runs?.get(params)?.text === known.text) return params;
    this.#keep(revision, params, known);
    void this.#load(revision).then(() => this.#write(revision));
    return params;
  }

  /**
   * The scene says that what it registered for these parameters is not all there is any more: its
   * code threw, or it had more to say than it could. Nothing can be concluded from it from now on.
   */
  unsure(revision: string, params: string): void {
    const known = this.#known.get(revision)?.get(params);
    if (!known?.registration.complete) return;
    const registration = { ...known.registration, complete: false };
    this.#keep(revision, params, { ...known, registration, text: JSON.stringify(registration) });
    void this.#load(revision).then(() => this.#write(revision));
  }

  #keep(revision: string, params: string, known: Known): void {
    const runs = this.#known.get(revision) ?? new Map<string, Known>();
    runs.delete(params);
    runs.set(params, known);
    for (const oldest of runs.keys()) {
      if (runs.size <= MAX_RUNS) break;
      runs.delete(oldest);
    }
    this.#known.delete(revision);
    this.#known.set(revision, runs);
    for (const oldest of this.#known.keys()) {
      if (this.#known.size <= MAX_REVISIONS) break;
      this.#known.delete(oldest);
    }
    this.#changed();
  }

  /** What the cache has for a revision, once. What came since is newer and stays. */
  #load(revision: string): Promise<void> {
    const project = this.#project;
    const known = this.#loaded.get(revision);
    if (known) return known;
    if (!this.#cache || project === undefined) return Promise.resolve();
    const loading = this.#cache.read(keyOf(project, revision)).then((kept) => {
      if (this.#project !== project) return;
      const { version, runs } = (kept ?? {}) as { version?: unknown; runs?: unknown };
      if (version !== CACHE_VERSION || !Array.isArray(runs)) return;
      let added = false;
      for (const run of runs.slice(-MAX_RUNS)) {
        const read = readRegistration(run);
        if (!read) continue;
        const params = paramsKeyOf(read.registration);
        if (this.#known.get(revision)?.has(params)) continue;
        const older = this.#known.get(revision);
        // What the cache had goes before what this page heard, which is newer.
        const runsNow = new Map([[params, knownOf(read)], ...(older ?? [])]);
        this.#known.set(revision, runsNow);
        added = true;
      }
      if (added) this.#changed();
    });
    this.#loaded.set(revision, loading);
    return loading;
  }

  #write(revision: string): void {
    const project = this.#project;
    const runs = this.#known.get(revision);
    if (!this.#cache || project === undefined || !runs) return;
    // Parameters are kept as the values they were, which reading turns into JSON again.
    const asRead = ({ registration }: Known) => ({
      ...registration,
      params: Object.fromEntries(
        Object.entries(registration.params).map(([path, text]) => [path, JSON.parse(text)]),
      ),
    });
    void this.#cache.write(keyOf(project, revision), {
      version: CACHE_VERSION,
      runs: [...runs.values()].map(asRead),
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
