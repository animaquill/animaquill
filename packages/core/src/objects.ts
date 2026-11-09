import {
  CLIP_SOUND,
  CLIP_VISUAL,
  ELEMENT_PROPERTIES,
  SCENE_VISUAL,
  builtInEffect,
  effectPath,
  toSeconds,
  type MediaRef,
  type ObjectDescriptor,
  type PropertySpec,
  type SceneManifest,
  type Value,
  type ValueType,
} from "@animaquill/schema";
import {
  clipOffset,
  clipStart,
  effectsOf,
  entryOf,
  type ClipState,
  type ProjectState,
} from "./model.ts";
import {
  aliasPathsOf,
  elementPath,
  isIdPart,
  objectPath,
  paramDefault,
  paramPath,
  type Registration,
  type SceneElement,
} from "./registration.ts";
import { channelsOf, effectiveProperties, fitOf, formatOf, type Version } from "./render-plan.ts";
import { sceneSourceOf } from "./scene-plan.ts";
import { boxOf, stageOf, type Size } from "./view.ts";

const WITH_A_PICTURE = new Set(["video", "image", "color"]);

/**
 * The objects of a clip that the editor knows by itself, which is everything about it that can be
 * edited or animated apart from what the scene of a clip declares and registers: see `describeClip`.
 */
export function objectsOf(clip: ClipState): readonly ObjectDescriptor[] {
  if (clip.source.kind === "scene") return withEffects(clip, [SCENE_VISUAL]);
  if (clip.source.kind === "sound") return [CLIP_SOUND];
  return WITH_A_PICTURE.has(clip.source.kind) ? withEffects(clip, [CLIP_VISUAL]) : [];
}

/** The types of the objects of effects: what holds them, and each of them by the type of effect. */
export const EFFECT_OBJECT_TYPES = { effects: "clip.effects", prefix: "effect." } as const;

/** Where the effects of a clip are in its tree. */
export const EFFECTS_OBJECT_ID = "effects";

/** The object of an effect of a clip, by the id of the effect. */
export const effectObjectId = (effect: string): string => `effect.${effect}`;

const effectObjects = new WeakMap<object, readonly ObjectDescriptor[]>();

/**
 * The effects of a clip, as objects: one that holds them, and one for each, in their order, with
 * what each takes. One that this editor does not know describes nothing, so its values show as
 * values that nothing describes.
 */
export function effectObjectsOf(clip: ClipState): readonly ObjectDescriptor[] {
  const { effects } = clip;
  if (!effects) return [];
  const known = effectObjects.get(effects);
  if (known) return known;
  const list = effectsOf(clip);
  const objects: ObjectDescriptor[] =
    list.length === 0
      ? []
      : [
          { id: EFFECTS_OBJECT_ID, type: EFFECT_OBJECT_TYPES.effects, properties: [] },
          ...list.map(({ id, type }): ObjectDescriptor => {
            const spec = builtInEffect(type);
            return {
              id: effectObjectId(id),
              type: `${EFFECT_OBJECT_TYPES.prefix}${type}`,
              parent: EFFECTS_OBJECT_ID,
              properties: (spec?.properties ?? []).map((parameter): PropertySpec => ({
                ...parameter,
                path: effectPath(id, parameter.path),
              })),
            };
          }),
        ];
  effectObjects.set(effects, objects);
  return objects;
}

/** What the editor knows of a clip, with its effects after it. */
function withEffects(
  clip: ClipState,
  objects: readonly ObjectDescriptor[],
): readonly ObjectDescriptor[] {
  const effects = effectObjectsOf(clip);
  return effects.length === 0 ? objects : [...objects, ...effects];
}

/** What a scene registered, and whether it ran with what a clip holds. */
export interface FoundRegistration {
  readonly registration: Registration;
  /**
   * It ran with the same parameters as the clip has, as far as its code read them. Otherwise it may
   * have registered something else for this clip, so it only shows what there probably is.
   */
  readonly exact: boolean;
}

/** What is known of scenes apart from the project: what their code registered when it ran. */
export interface SceneRegistry {
  /**
   * What a state of a scene registered, by its revision, for a clip: `paramOf` gives what the clip
   * holds for a parameter, as JSON, the way `Registration.params` has it. Undefined when it did not
   * run here.
   */
  registrationOf(
    revision: string,
    paramOf: (path: string) => string,
  ): FoundRegistration | undefined;
}

/** What a clip holds for a parameter, the way a registration compares it. */
export const paramTextOf = (clip: ClipState, path: string): string =>
  JSON.stringify(entryOf(effectiveProperties(clip), path) ?? null);

/**
 * How far the code of a scene got when it last ran: through loading, or not, or it never ran here.
 * Only after `complete` is a channel that nothing describes one that lost its object.
 */
export type SceneRun = "complete" | "partial" | "never";

/** Keys of a property that are under a path it went by before. */
export interface PendingRename {
  readonly from: string;
  readonly to: string;
}

/** What a clip offers, and how much of that is known. */
export interface ClipDescription {
  readonly objects: readonly ObjectDescriptor[];
  /** For a clip with a scene. */
  readonly ran?: SceneRun;
  /** Properties that read keys from a path they went by before, which `property.rename` moves. */
  readonly renames?: readonly PendingRename[];
}

/** The objects of a scene that are the same for every clip of it. Built-in types have a name. */
export const SCENE_OBJECT_TYPES = {
  params: "scene.params",
  elements: "scene.elements",
  element: "scene.element",
} as const;

const PARAMS_ID = "params";
const ELEMENTS_ID = "elements";

/**
 * What `scene.json` declares, as properties. Parameters with ids no path can hold are left out, and
 * so is a default of another type than its parameter: it would be no value of it.
 */
function paramsObject(manifest: SceneManifest | undefined): ObjectDescriptor | undefined {
  const properties = (manifest?.params ?? []).flatMap((param): PropertySpec[] => {
    if (!isIdPart(param.id)) return [];
    const type = param.type as ValueType;
    const spec: Record<string, unknown> = { path: paramPath(param.id), type, name: param.name };
    for (const key of ["min", "max", "options"] as const) {
      if (param[key] !== undefined) spec[key] = param[key];
    }
    const fallback = paramDefault(param);
    if (fallback !== undefined) spec.default = fallback;
    return [spec as unknown as PropertySpec];
  });
  return properties.length > 0
    ? { id: PARAMS_ID, type: SCENE_OBJECT_TYPES.params, properties }
    : undefined;
}

function elementObject({ id, kind, start }: SceneElement): ObjectDescriptor {
  return {
    id: `element.${id}`,
    name: id,
    type: SCENE_OBJECT_TYPES.element,
    parent: ELEMENTS_ID,
    properties: ELEMENT_PROPERTIES[kind].map((spec): PropertySpec => {
      const begins = start && entryOf(start, spec.path);
      return {
        ...spec,
        path: elementPath(id, spec.path),
        ...(begins !== undefined && { default: begins }),
      };
    }),
  };
}

/** A property with the paths it went by before, in the order they count. */
interface Placed {
  readonly spec: PropertySpec;
  readonly before: readonly string[];
}

interface Resolved {
  readonly objects: readonly ObjectDescriptor[];
  /** Properties with paths from before. Empty for most scenes. */
  readonly renamed: readonly {
    readonly object: number;
    readonly index: number;
    readonly placed: Placed;
  }[];
}

/** An object of code with paths for the clip, and where it can find its keys under older names. */
function codeObject(
  object: ObjectDescriptor,
  renamed: (index: number, placed: Placed) => void,
): ObjectDescriptor {
  const { id, name, parent, spans, presence } = object;
  const properties = object.properties.map((spec, index): PropertySpec => {
    const before = aliasPathsOf(object, spec);
    const { aliases: _aliases, ...rest } = spec;
    const placed: PropertySpec = {
      ...rest,
      path: objectPath(id, spec.path),
      name: spec.name ?? spec.path,
    };
    if (before.length > 0) renamed(index, { spec: placed, before });
    return placed;
  });
  return {
    id: `object.${id}`,
    name: name ?? id,
    ...(parent !== undefined && { parent: `object.${parent}` }),
    ...(spans && { spans }),
    ...(presence !== undefined && { presence: objectPath(id, presence) }),
    properties,
  };
}

/** What every clip of a state of a scene has, apart from older paths that it has keys under. */
function resolve(
  manifest: SceneManifest | undefined,
  registration: Registration | undefined,
): Resolved {
  const objects: ObjectDescriptor[] = [SCENE_VISUAL];
  const params = paramsObject(manifest);
  if (params) objects.push(params);
  const elements = registration?.elements ?? [];
  if (elements.length > 0) {
    objects.push({ id: ELEMENTS_ID, type: SCENE_OBJECT_TYPES.elements, properties: [] });
    objects.push(...elements.map(elementObject));
  }
  const renamed: Resolved["renamed"][number][] = [];
  for (const object of registration?.objects ?? []) {
    const at = objects.length;
    objects.push(
      codeObject(object, (index, placed) => renamed.push({ object: at, index, placed })),
    );
  }
  return { objects, renamed };
}

const NO_REGISTRATION = {};
const NO_MANIFEST = {};
const resolutions = new WeakMap<object, WeakMap<object, Resolved>>();

function resolvedOf(manifest: SceneManifest | undefined, registration: Registration | undefined) {
  const byRegistration = registration ?? NO_REGISTRATION;
  let known = resolutions.get(byRegistration);
  if (!known) resolutions.set(byRegistration, (known = new WeakMap()));
  const byManifest = manifest ?? NO_MANIFEST;
  let found = known.get(byManifest);
  if (!found) known.set(byManifest, (found = resolve(manifest, registration)));
  return found;
}

/** All paths that something describes, which are no path from before for anything else. */
const described = new WeakMap<Resolved, ReadonlySet<string>>();

function describedPaths(resolved: Resolved): ReadonlySet<string> {
  let paths = described.get(resolved);
  if (!paths) {
    paths = new Set(
      resolved.objects.flatMap(({ properties }) => properties.map(({ path }) => path)),
    );
    described.set(resolved, paths);
  }
  return paths;
}

/**
 * Where the keys of a property are for a clip: under its path, or else under the first path it went
 * by before that has any. That is what keeps keys working when code renames what they are about.
 * A path that something else describes is that one's, and never anybody's from before.
 */
function withRenames(clip: ClipState, resolved: Resolved) {
  const { objects, renamed } = resolved;
  if (renamed.length === 0) return { objects, renames: [] };
  const properties = effectiveProperties(clip);
  const taken = describedPaths(resolved);
  const renames: PendingRename[] = [];
  let changed: ObjectDescriptor[] | undefined;
  for (const { object, index, placed } of renamed) {
    const { spec, before } = placed;
    if (entryOf(properties, spec.path) !== undefined) continue;
    const from = before.find((path) => !taken.has(path) && entryOf(properties, path) !== undefined);
    if (from === undefined) continue;
    renames.push({ from, to: spec.path });
    changed ??= [...objects];
    const target = changed[object] as ObjectDescriptor;
    const list = [...target.properties];
    list[index] = { ...spec, path: from };
    const presence = target.presence === spec.path ? { presence: from } : {};
    changed[object] = { ...target, ...presence, properties: list };
  }
  return { objects: changed ?? objects, renames };
}

/**
 * Everything a clip offers: what the editor knows of it, the parameters its scene declares, and
 * what the code of the scene registered when it last ran here. Paths are those of the clip, so
 * the properties of code objects are `object.<id>.<property>`. What code registered is not trusted:
 * it went through `readRegistration`.
 */
export function describeClip(
  state: ProjectState,
  clip: ClipState,
  registry: SceneRegistry | undefined,
): ClipDescription {
  const { source } = clip;
  if (source.kind !== "scene" || typeof source.scene !== "string") {
    return { objects: objectsOf(clip) };
  }
  const scene = sceneSourceOf(state, source.scene);
  const manifest = entryOf(state.scenes, source.scene);
  const found =
    scene && registry?.registrationOf(scene.revision, (path) => paramTextOf(clip, path));
  const registration = found?.registration;
  const renamed = withRenames(clip, resolvedOf(manifest, registration));
  const { renames } = renamed;
  const objects = withEffects(clip, renamed.objects);
  // What ran with other parameters shows what there probably is, and says nothing about the rest.
  let ran: SceneRun = "never";
  if (found) ran = found.exact && found.registration.complete ? "complete" : "partial";
  return { objects, ran, ...(renames.length > 0 && { renames }) };
}

/**
 * What the name of a property is looked up by: the properties of elements have the same names,
 * whatever the ids of the elements are.
 */
export function nameKeyOf(path: string): string {
  const element = /^(element|effect)\.[^.]+\.([^.]+)$/.exec(path);
  return element ? `${element[1]}.${element[2]}` : path;
}

/** How large the media of a clip is, as far as the project knows. */
export function naturalSizeOf(state: ProjectState, clip: ClipState): Size | undefined {
  const { media } = clip.source as { readonly media?: MediaRef };
  const info = media && "asset" in media ? entryOf(state.assets, media.asset)?.info : undefined;
  return info?.width && info.height ? { width: info.width, height: info.height } : undefined;
}

const SIDES: Readonly<Record<string, keyof Size>> = {
  "transform.width": "width",
  "transform.height": "height",
};

/**
 * What a clip without this property uses at a moment on the timeline. Most have a default. A clip box
 * without a size follows the stage or the media, so that depends on where the clip is.
 */
export function valueWithout(
  state: ProjectState,
  clip: ClipState,
  spec: PropertySpec,
  time: number,
  version?: Version,
): Value | undefined {
  if (spec.default !== undefined) return spec.default;
  const side = entryOf(SIDES, spec.path);
  const format = formatOf(state, version);
  if (!side || !format) return undefined;
  const properties = effectiveProperties(clip, version);
  const layer = {
    fit: fitOf(properties),
    channels: channelsOf(properties),
    offset: toSeconds(clipOffset(clip)),
    start: toSeconds(clipStart(clip)),
  };
  return boxOf(layer, time, naturalSizeOf(state, clip), stageOf(format))[side];
}
