import type { SceneParam } from "@animaquill/core";
import { compileChannel, sample, type Channel } from "@animaquill/core/curve";
import {
  REGISTRATION_LIMITS,
  aliasPathsOf,
  objectPath,
  paramPath,
  readObject,
  type RegistrationProblemCode,
} from "@animaquill/core/registration";
import type { PropertyValue, Value } from "@animaquill/schema";
import {
  COLOR_PATTERN,
  type ObjectDescriptor,
  type PropertySpec,
  type ValueType,
} from "@animaquill/schema/properties";

/**
 * What the clip of a scene holds for it, and what code reads of that: parameters with `aq.param`,
 * objects that code registers with `aq.object`. Curves come as the clip stores them and get worked
 * out here, on the clock of the scene, so that nothing has to cross over for every frame. This runs
 * in the realm of the project, so it takes what it needs before any project code runs.
 */

const stringify = JSON.stringify;
const entries = Object.entries;
const freeze = Object.freeze;

/** What the clip holds for the scene by path, as it stores it, and what that comes to. */
export class ClipValues {
  readonly #raw = new Map<string, unknown>();
  readonly #prepared = new Map<string, { readonly type: ValueType; readonly channel?: Channel }>();
  /** Goes up with every change, for whatever depends on which paths there are. */
  version = 0;

  constructor(initial?: Readonly<Record<string, unknown>>) {
    if (initial) this.change(initial);
  }

  /** Takes changes in. Null takes a path away. Gives the paths that are different now. */
  change(changes: Readonly<Record<string, unknown>>): readonly string[] {
    const changed: string[] = [];
    for (const [path, value] of entries(changes)) {
      if (value === null || value === undefined) {
        if (!this.#raw.delete(path)) continue;
      } else {
        const before = this.#raw.get(path);
        if (before !== undefined && stringify(before) === stringify(value)) continue;
        this.#raw.set(path, value);
      }
      this.#prepared.delete(path);
      changed.push(path);
    }
    if (changed.length > 0) this.version += 1;
    return changed;
  }

  has(path: string): boolean {
    return this.#raw.has(path);
  }

  /** What the clip holds for a path, as it stores it. */
  raw(path: string): unknown {
    return this.#raw.get(path);
  }

  paths(): readonly string[] {
    return [...this.#raw.keys()];
  }

  /** A path prepared to be read as a type. Undefined when it holds nothing of the type. */
  channel(path: string, type: ValueType): Channel | undefined {
    let prepared = this.#prepared.get(path);
    if (prepared?.type !== type) {
      const raw = this.#raw.get(path) as PropertyValue | undefined;
      const channel = raw === undefined ? undefined : compileChannel(raw, type);
      prepared = channel ? { type, channel } : { type };
      this.#prepared.set(path, prepared);
    }
    return prepared.channel;
  }

  /** What a path comes to at a reading of the clock. Undefined when it holds nothing of the type. */
  at(path: string, type: ValueType, seconds: number): Value | undefined {
    const channel = this.channel(path, type);
    return channel && sample(channel, seconds);
  }
}

/** Says what is wrong, with where the project called from when that is known. */
export type ContentReport = (code: string, target?: string) => void;

/** What a property given as nothing but a value is: the value is its default, and says its type. */
function typeOfValue(value: unknown): ValueType | undefined {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return COLOR_PATTERN.test(value) ? "color" : "text";
  if (!Array.isArray(value)) return undefined;
  return value.length >= 2 && value.length <= 4 ? (`vec${value.length}` as ValueType) : "numbers";
}

/**
 * What `aq.object` was given, as a description to read: properties come as a map, and one that is
 * only a value is short for a property of that type with that value as its default.
 */
function rawObject(id: unknown, options: unknown): Record<string, unknown> {
  const given = typeof options === "object" && options !== null ? options : {};
  const { properties, name, parent, spans, presence, aliases } = given as Record<string, unknown>;
  const list =
    typeof properties === "object" && properties !== null && !Array.isArray(properties)
      ? entries(properties).map(([path, spec]) =>
          typeof spec === "object" && spec !== null && !Array.isArray(spec)
            ? { ...spec, path }
            : { path, type: typeOfValue(spec), default: spec },
        )
      : [];
  return { id, name, parent, spans, presence, aliases, properties: list };
}

interface Registered {
  readonly descriptor: ObjectDescriptor;
  readonly text: string;
  readonly handle: ObjectHandle;
  /** What goes to the editor of it, which stops following an object that keeps changing. */
  readonly told: ObjectDescriptor;
  /** How often it came with another description. */
  readonly changes: number;
}

export interface ObjectHandle {
  readonly id: string;
  /**
   * The values at a reading of the clock of the scene, in seconds, which is now unless it says
   * otherwise. Keys are in there already. It is the same object every time, with new values.
   */
  at(seconds?: number): Readonly<Record<string, Value>>;
}

/**
 * How often an object can come with another description before it counts as one that keeps
 * changing. A few times is code that is still finding its way; more is a description that goes by
 * time, which is what keys are for.
 */
export const MAX_DESCRIPTION_CHANGES = 3;

/** The objects code registered, by id, with what their values come to. */
export class CodeObjects {
  readonly #objects = new Map<string, Registered>();
  readonly #values: ClipValues;
  readonly #now: () => number;
  readonly #changed: () => void;
  /** Goes up whenever objects come or go, which is what aliases depend on. */
  #version = 0;
  /** Some objects could not be registered, so what is there is not all there is. */
  #cut = false;
  /** Some objects keep changing their description, see `MAX_DESCRIPTION_CHANGES`. */
  #unstable = false;
  /** The first frame ran, so that what comes now came late: see `firstFrameRan`. */
  #afterFirstFrame = false;
  /** Code registered something after its first frame, which it may do again at any moment. */
  #late = false;

  constructor(values: ClipValues, now: () => number, changed: () => void) {
    this.#values = values;
    this.#now = now;
    this.#changed = changed;
  }

  /** Whether what the editor gets of these is all there is. */
  get settled(): boolean {
    return !this.#cut && !this.#unstable && !this.#late;
  }

  /**
   * What code registers by the end of its first frame is what it registers. An object that comes
   * later could have come at any moment the editor never got to, so then nothing is all there is.
   */
  firstFrameRan(): void {
    this.#afterFirstFrame = true;
  }

  /**
   * Registers an object, or finds the one with this id when it has not changed: code that does this
   * on every frame costs nothing more. One that changed takes the place of the one before. A mistake
   * leaves out what it is about and gets reported, and the code goes on with its defaults.
   */
  register(id: unknown, options: unknown, report: ContentReport): ObjectHandle {
    const said: [RegistrationProblemCode, string | undefined][] = [];
    const raw = rawObject(id, options);
    let descriptor = readObject(raw, (code, target) => said.push([code, target]));
    for (const [code, target] of said) report(code, target);
    const known = descriptor && this.#objects.get(descriptor.id);
    const text = descriptor && stringify(descriptor);
    if (known && known.text === text) return known.handle;
    if (descriptor && !known && this.#objects.size >= REGISTRATION_LIMITS.objects) {
      report("object-too-many", "objects");
      this.#cut = true;
      descriptor = undefined;
    }
    // Without an id that a path can hold, the values are the defaults, and that is all they can be.
    const shape = descriptor ?? readObject({ ...raw, id: "unregistered" }, () => {});
    const handle = this.#handleOf(shape, descriptor !== undefined);
    if (!descriptor || text === undefined) return handle;
    if (!known && this.#afterFirstFrame && !this.#late) {
      report("object-late", descriptor.id);
      this.#late = true;
    }
    const changes = known ? known.changes + 1 : 0;
    const keepsChanging = changes > MAX_DESCRIPTION_CHANGES;
    if (keepsChanging && !this.#unstable) report("object-unstable", descriptor.id);
    this.#unstable ||= keepsChanging;
    const told = keepsChanging && known ? known.told : descriptor;
    this.#objects.set(descriptor.id, { descriptor, text, handle, told, changes });
    this.#version += 1;
    if (!keepsChanging) this.#changed();
    return handle;
  }

  #handleOf(descriptor: ObjectDescriptor | undefined, registered: boolean): ObjectHandle {
    const values = this.#values;
    const result: Record<string, Value> = {};
    const now = this.#now;
    const objects = this.#objects;
    const versionOf = () => this.#version;
    const specs = descriptor?.properties ?? [];
    // Where each property reads from only changes with what the clip holds and what is registered,
    // not with every frame.
    let channels: readonly (Channel | undefined)[] = [];
    let preparedFor = "";
    return freeze({
      id: descriptor && registered ? descriptor.id : "",
      at(seconds?: number) {
        const clock = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : now();
        const version = `${values.version} ${versionOf()}`;
        if (preparedFor !== version && descriptor) {
          preparedFor = version;
          const taken = new Set(objects.keys());
          channels = specs.map((spec) => {
            if (!registered) return undefined;
            const paths = [
              objectPath(descriptor.id, spec.path),
              ...aliasPathsOf(descriptor, spec, taken),
            ];
            const path = paths.find((candidate) => values.has(candidate));
            return path === undefined ? undefined : values.channel(path, spec.type);
          });
        }
        for (let index = 0; index < specs.length; index += 1) {
          const spec = specs[index] as PropertySpec;
          const channel = channels[index];
          const value = channel ? sample(channel, clock) : spec.default;
          if (value !== undefined) result[spec.path] = value;
        }
        return result;
      },
    });
  }

  /** What the editor gets to know, in the order it got registered. */
  descriptors(): readonly ObjectDescriptor[] {
    return [...this.#objects.values()].map(({ told }) => told);
  }
}

/** The parameters of a scene, as code reads them, which is what the clip says at this moment. */
export class SceneParams {
  readonly #params: ReadonlyMap<string, SceneParam>;
  readonly #values: ClipValues;
  readonly #now: () => number;
  readonly #report: ContentReport;
  /** Read before the scene was ready, and later. A value read only once does not follow changes. */
  readonly #early = new Set<string>();
  readonly #later = new Set<string>();
  readonly #missing = new Set<string>();
  readonly #warned = new Set<string>();
  /** What the clip held for each parameter when code first read it, as stored: null for nothing. */
  readonly #first = new Map<string, unknown>();
  readonly #seenMore: () => void;
  #ready = false;

  /** `seenMore` hears of a parameter that code read for the first time, see `seen`. */
  constructor(
    params: readonly SceneParam[],
    values: ClipValues,
    now: () => number,
    report: ContentReport,
    seenMore: () => void = () => {},
  ) {
    this.#params = new Map(params.map((param) => [param.id, param]));
    this.#values = values;
    this.#now = now;
    this.#report = report;
    this.#seenMore = seenMore;
  }

  read(id: unknown, seconds?: unknown): Value | undefined {
    const name = String(id);
    const param = this.#params.get(name);
    if (!param) {
      if (!this.#missing.has(name)) this.#report("missing-param", name.slice(0, 200));
      this.#missing.add(name);
      return undefined;
    }
    (this.#ready ? this.#later : this.#early).add(name);
    const path = paramPath(name);
    if (!this.#first.has(path)) {
      this.#first.set(path, this.#values.raw(path) ?? null);
      this.#seenMore();
    }
    const clock = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : this.#now();
    return this.#values.at(path, param.type, clock) ?? param.default;
  }

  /**
   * The parameters code read so far, with what the clip held for them then. What code registered
   * can depend on them, so a registration goes by these.
   */
  seen(): Readonly<Record<string, unknown>> {
    return Object.fromEntries(this.#first);
  }

  /** From here on, code reads values in its own time. */
  loaded(): void {
    this.#ready = true;
  }

  /**
   * Some paths changed. A parameter that code only read while the scene was loading will not show
   * that, and people should know why.
   */
  changed(paths: readonly string[]): void {
    for (const path of paths) {
      if (!path.startsWith("param.")) continue;
      const id = path.slice("param.".length);
      if (!this.#early.has(id) || this.#later.has(id) || this.#warned.has(id)) continue;
      this.#warned.add(id);
      this.#report("param-read-once", id);
    }
  }
}
