import type { SceneParam } from "@animaquill/core";
import { compileChannel, sample, type Channel } from "@animaquill/core/curve";
import {
  REGISTRATION_LIMITS,
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

/** A property, with where its keys can be. The first path that holds any counts. */
interface Placed {
  readonly spec: PropertySpec;
  readonly paths: readonly string[];
}

interface Registered {
  readonly descriptor: ObjectDescriptor;
  readonly text: string;
  readonly handle: ObjectHandle;
}

export interface ObjectHandle {
  readonly id: string;
  /**
   * The values at a reading of the clock of the scene, in seconds, which is now unless it says
   * otherwise. Keys are in there already. It is the same object every time, with new values.
   */
  at(seconds?: number): Readonly<Record<string, Value>>;
}

function placedOf({ id, aliases = [], properties }: ObjectDescriptor): readonly Placed[] {
  return properties.map((spec) => {
    const own = spec.aliases ?? [];
    const paths = [
      objectPath(id, spec.path),
      ...own.map((alias) => objectPath(id, alias)),
      ...aliases.flatMap((was) => [spec.path, ...own].map((alias) => objectPath(was, alias))),
    ];
    return { spec, paths };
  });
}

/** The objects code registered, by id, with what their values come to. */
export class CodeObjects {
  readonly #objects = new Map<string, Registered>();
  readonly #values: ClipValues;
  readonly #now: () => number;
  readonly #changed: () => void;

  constructor(values: ClipValues, now: () => number, changed: () => void) {
    this.#values = values;
    this.#now = now;
    this.#changed = changed;
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
      descriptor = undefined;
    }
    // Without an id that a path can hold, the values are the defaults, and that is all they can be.
    const shape = descriptor ?? readObject({ ...raw, id: "unregistered" }, () => {});
    const handle = this.#handleOf(shape, descriptor !== undefined);
    if (descriptor && text !== undefined) {
      this.#objects.set(descriptor.id, { descriptor, text, handle });
      this.#changed();
    }
    return handle;
  }

  #handleOf(descriptor: ObjectDescriptor | undefined, registered: boolean): ObjectHandle {
    const placed = descriptor ? placedOf(descriptor) : [];
    const values = this.#values;
    const result: Record<string, Value> = {};
    const now = this.#now;
    // What each property reads only changes with what the clip holds, not with every frame.
    let channels: readonly (Channel | undefined)[] = [];
    let preparedIn = -1;
    return freeze({
      id: descriptor && registered ? descriptor.id : "",
      at(seconds?: number) {
        const clock = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : now();
        if (preparedIn !== values.version) {
          preparedIn = values.version;
          channels = placed.map(({ spec, paths }) => {
            const path = registered ? paths.find((candidate) => values.has(candidate)) : undefined;
            return path === undefined ? undefined : values.channel(path, spec.type);
          });
        }
        for (let index = 0; index < placed.length; index += 1) {
          const { spec } = placed[index] as Placed;
          const channel = channels[index];
          const value = channel ? sample(channel, clock) : spec.default;
          if (value !== undefined) result[spec.path] = value;
        }
        return result;
      },
    });
  }

  /** What there is, in the order it got registered. */
  descriptors(): readonly ObjectDescriptor[] {
    return [...this.#objects.values()].map(({ descriptor }) => descriptor);
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
  #ready = false;

  constructor(
    params: readonly SceneParam[],
    values: ClipValues,
    now: () => number,
    report: ContentReport,
  ) {
    this.#params = new Map(params.map((param) => [param.id, param]));
    this.#values = values;
    this.#now = now;
    this.#report = report;
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
    const clock = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : this.#now();
    return this.#values.at(paramPath(name), param.type, clock) ?? param.default;
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
