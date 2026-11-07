import { isAnimation, type MediaRef, type PropertyValue } from "@animaquill/schema";
import { entryOf, type ProjectState } from "./model.ts";

/** One asset a scene can ask for with `aq.asset(id)`. */
export interface SceneAsset {
  readonly id: string;
  /** The file, by its content. */
  readonly file: string;
}

/** What a clip shows when it shows a scene. Two of these are the same scene when they are equal. */
export interface SceneSource {
  readonly kind: "scene";
  readonly scene: string;
  /** The file to start with, from the root of the project. */
  readonly entry: string;
  readonly runtime: number;
  /** Changes when anything the scene gets changes, and only then. */
  readonly revision: string;
  readonly assets: readonly SceneAsset[];
  /** What its random numbers come from. A clip that gets cut in two goes on as it was. */
  readonly seed: number;
}

/** Everything in here goes to every scene and sound that asks. */
const SHARED_FOLDER = "code/";

const folderOf = (scene: string) => `scenes/${scene}/`;
const soundFolderOf = (sound: string) => `sounds/${sound}/`;

/**
 * Tells two texts apart: this is about seeing that something changed, and keeps nobody from doing
 * anything. cyrb53, by bryc, which is in the public domain.
 */
export function hashOfText(text: string): string {
  let first = 0xdeadbeef;
  let second = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, 2654435761);
    second = Math.imul(second ^ code, 1597334677);
  }
  first =
    Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909);
  second =
    Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909);
  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(36);
}

/** `aq.asset("logo")`. An id that code works out cannot be found here, see the scene runtime. */
const ASSET_CALL = /\baq\s*\.\s*asset\(\s*(["'`])([A-Za-z0-9][A-Za-z0-9_-]*)\1\s*\)/g;

interface FileFacts {
  readonly text: string;
  readonly hash: string;
  readonly assets: readonly string[];
}

/**
 * What is known about the files of a project. Files only change by being replaced, and one change
 * leaves all others as they were, so all of this carries over from one state to the next.
 */
class FileIndex {
  readonly #files: ProjectState["files"];
  #before: FileIndex | undefined;
  readonly #facts = new Map<string, FileFacts>();
  /** The paths in each folder of `scenes/` and `sounds/`, and in `code/`. */
  #folders: Map<string, string[]> | undefined;

  constructor(files: ProjectState["files"], before: FileIndex | undefined) {
    this.#files = files;
    this.#before = before;
  }

  /** Only what the last state knew carries over, or all states would stay around for ever. */
  forget(): void {
    this.#before = undefined;
  }

  factsOf(path: string): FileFacts {
    const known = this.#facts.get(path);
    if (known) return known;
    const text = entryOf(this.#files, path) ?? "";
    const before = this.#before?.seen(path);
    const facts =
      before?.text === text
        ? before
        : {
            text,
            hash: hashOfText(text),
            assets: [...text.matchAll(ASSET_CALL)].map((call) => call[2] as string),
          };
    this.#facts.set(path, facts);
    return facts;
  }

  seen(path: string): FileFacts | undefined {
    return this.#facts.get(path);
  }

  /** Which files a scene or sound gets: its own folder and what all of them share. */
  pathsIn(own: string): readonly string[] {
    if (!this.#folders) {
      this.#folders = new Map();
      for (const path of Object.keys(this.#files)) {
        const folder = path.startsWith(SHARED_FOLDER)
          ? SHARED_FOLDER
          : /^(?:scenes|sounds)\/[^/]+\//.exec(path)?.[0];
        if (folder === undefined) continue;
        const paths = this.#folders.get(folder);
        if (paths) paths.push(path);
        else this.#folders.set(folder, [path]);
      }
    }
    return [
      ...(this.#folders.get(own) ?? []),
      ...(this.#folders.get(SHARED_FOLDER) ?? []),
    ].toSorted();
  }
}

const indexes = new WeakMap<ProjectState["files"], FileIndex>();
let latest: FileIndex | undefined;

function indexOf(files: ProjectState["files"]): FileIndex {
  const known = indexes.get(files);
  if (known) return known;
  latest?.forget();
  latest = new FileIndex(files, latest);
  indexes.set(files, latest);
  return latest;
}

/**
 * The files of the project a scene may read. The sandbox only gets these, so whatever a scene does
 * with what it reads, it cannot be about anything else in the project.
 */
export const sceneFilesOf = (state: ProjectState, scene: string): readonly string[] =>
  indexOf(state.files).pathsIn(folderOf(scene));

/** The same for a sound, which gets nothing else either. */
export const soundFilesOf = (state: ProjectState, sound: string): readonly string[] =>
  indexOf(state.files).pathsIn(soundFolderOf(sound));

/** What the content of some files comes to. It changes when one of them does, and only then. */
export function revisionOfFiles(state: ProjectState, paths: readonly string[]): readonly string[] {
  const files = indexOf(state.files);
  return paths.map((path) => `${path}\n${files.factsOf(path).hash}`);
}

const assetIdOf = (value: PropertyValue | undefined) => {
  const plain = value !== undefined && isAnimation(value) ? undefined : value;
  const media = (typeof plain === "object" ? plain : undefined) as MediaRef | undefined;
  return media && "asset" in media ? media.asset : undefined;
};

/** What a scene can have of the assets: what its code names, and what a parameter starts out with. */
function assetsOf(
  state: ProjectState,
  scene: string,
  paths: readonly string[],
): readonly SceneAsset[] {
  const files = indexOf(state.files);
  const ids = new Set(paths.flatMap((path) => files.factsOf(path).assets));
  for (const param of entryOf(state.scenes, scene)?.params ?? []) {
    const id = param.type === "asset" ? assetIdOf(param.default) : undefined;
    if (id !== undefined) ids.add(id);
  }
  return [...ids].toSorted().flatMap((id) => {
    const file = entryOf(state.assets, id)?.hash;
    return file === undefined ? [] : [{ id, file }];
  });
}

/**
 * What in the code of a project asks for an asset: a file that names it, or a parameter that starts
 * out with it. Dead code counts, because nothing can tell. What code works out cannot be found.
 */
export function codeUsingAsset(state: ProjectState, asset: string): string | undefined {
  const files = indexOf(state.files);
  const named = Object.keys(state.files).find((path) => files.factsOf(path).assets.includes(asset));
  if (named !== undefined) return named;
  for (const [root, manifests] of Object.entries({ scenes: state.scenes, sounds: state.sounds })) {
    for (const [id, { params = [] }] of Object.entries(manifests)) {
      const startsWithIt = (param: (typeof params)[number]) =>
        param.type === "asset" && assetIdOf(param.default) === asset;
      if (params.some(startsWithIt)) return `${root}/${id}`;
    }
  }
  return undefined;
}

const sources = new Map<string, SceneSource>();

/** What a compositor has to know to show a scene, or undefined when there is no such scene. */
export function sceneSourceOf(state: ProjectState, scene: string): SceneSource | undefined {
  const manifest = entryOf(state.scenes, scene);
  if (!manifest) return undefined;
  const paths = sceneFilesOf(state, scene);
  const assets = assetsOf(state, scene, paths);
  const entry = `${folderOf(scene)}${manifest.entry}`;
  const { runtime } = manifest;
  const content = revisionOfFiles(state, paths);
  const revision = hashOfText(JSON.stringify([entry, runtime, content, assets]));
  const known = sources.get(scene);
  // A scene that stays what it was keeps its identity, which is how a plan sees that nothing changed.
  if (known?.revision === revision) return known;
  const source: SceneSource = {
    kind: "scene",
    scene,
    entry,
    runtime,
    revision,
    assets,
    seed: Number.parseInt(hashOfText(scene).slice(0, 6), 36),
  };
  sources.set(scene, source);
  return source;
}
