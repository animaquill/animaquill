import {
  CURRENT_SCENE_RUNTIME,
  Id,
  RelativePath,
  SceneManifest,
  SoundManifest,
  newId,
  type SceneManifest as Manifest,
  type SoundManifest as SoundManifestType,
} from "@animaquill/schema";
import { z } from "zod";
import { fail, type Draft } from "./draft.ts";
import { formatFailure } from "./failures.ts";
import { isSourceFile } from "./import-file.ts";
import { entryOf, type ProjectState } from "./model.ts";
import { isInUse } from "./references.ts";
import { removeUses } from "./resource-edits.ts";

import { MAX_SOURCE_BYTES, isTooLargeSource } from "./source-size.ts";

/** Folders a project folder keeps out of what it brings along, see the format. */
const isKeptOut = (part: string) => part.startsWith(".") || part === "node_modules";

/** Who a file belongs to: a scene or sound by its folder, or everybody for shared code. */
function ownerOf(path: string) {
  const [root, id = "", ...rest] = path.split("/");
  if (root === "code") return { kind: "code" as const };
  return { kind: root === "scenes" ? ("scene" as const) : ("sound" as const), id, rest };
}

/** A path in a project that holds code, as a command can write it. */
export const SourcePath = RelativePath.refine(
  isSourceFile,
  "只能写 scenes、sounds、code 里的代码文件",
)
  .refine((path) => !path.split("/").some(isKeptOut), "这个名字的文件不会跟项目走")
  .refine((path) => {
    const owner = ownerOf(path);
    return owner.kind === "code" || owner.rest.length > 0;
  }, "文件要放在场景或声音的文件夹里");

/** The folder has to be there: a file nothing can reach is a mistake, and the check finds it now. */
function assertOwnerExists(state: ProjectState, path: string): void {
  const owner = ownerOf(path);
  if (owner.kind === "code") return;
  const known = owner.kind === "scene" ? state.scenes : state.sounds;
  if (!entryOf(known, owner.id)) fail("not-found", { kind: "folder", id: owner.id });
}

function assertSize(path: string, text: string): void {
  if (isTooLargeSource(text)) fail("file-too-large", { path, limit: MAX_SOURCE_BYTES });
}

/** Where the folder of a scene or sound keeps what it is, which is no file anybody writes. */
function manifestOf(path: string): string | undefined {
  const owner = ownerOf(path);
  if (owner.kind === "code") return undefined;
  return owner.kind === "scene" ? `scenes/${owner.id}/scene.json` : `sounds/${owner.id}/sound.json`;
}

/** A folder and a file of one name cannot live next to each other once the project is a folder. */
function assertFits(state: ProjectState, path: string): void {
  const manifest = manifestOf(path);
  if (manifest !== undefined && (path === manifest || path.startsWith(`${manifest}/`))) {
    fail("path-taken", { path: manifest, by: "manifest" });
  }
  const parts = path.split("/");
  for (let length = 1; length < parts.length; length += 1) {
    const folder = parts.slice(0, length).join("/");
    if (entryOf(state.files, folder) !== undefined)
      fail("path-taken", { path: folder, by: "file" });
  }
  const inside = `${path}/`;
  if (Object.keys(state.files).some((file) => file.startsWith(inside))) {
    fail("path-taken", { path, by: "folder" });
  }
}

/** What every write of a file goes through, before anything gets written. */
function checkWrite(state: ProjectState, path: string, text: string): void {
  assertOwnerExists(state, path);
  assertSize(path, text);
  if (entryOf(state.files, path) === undefined) assertFits(state, path);
}

const sceneFile = (id: string, entry: string) => `scenes/${id}/${entry}`;
const soundFile = (id: string, entry: string) => `sounds/${id}/${entry}`;

function assertRuntime({ runtime }: { readonly runtime: number }): void {
  if (runtime > CURRENT_SCENE_RUNTIME) {
    fail("runtime-too-new", { runtime, current: CURRENT_SCENE_RUNTIME });
  }
}

function assertManifest(id: string, scene: Manifest, files: ProjectState["files"]): void {
  assertRuntime(scene);
  if (entryOf(files, sceneFile(id, scene.entry)) === undefined) {
    fail("missing-entry", { kind: "scene", entry: scene.entry });
  }
}

/** A sound runs in a worker, where no page can be. */
function assertSoundManifest(id: string, sound: SoundManifestType, files: ProjectState["files"]) {
  assertRuntime(sound);
  if (!/\.m?js$/.test(sound.entry))
    fail("invalid-value", { rule: "sound-entry", entry: sound.entry });
  if (entryOf(files, soundFile(id, sound.entry)) === undefined) {
    fail("missing-entry", { kind: "sound", entry: sound.entry });
  }
}

export const SceneAdd = z.strictObject({
  id: Id.optional(),
  /** What the scene is, as its `scene.json` says. */
  manifest: SceneManifest,
  /** By path in the folder of the scene. Scenes hold text: pictures and such are assets. */
  files: z.record(RelativePath, z.string()),
});

/** A scene with its files. An entry that is not there is a scene that can never run. */
export function addScene(draft: Draft, params: z.output<typeof SceneAdd>): { id: string } {
  const { manifest: scene, files } = params;
  const id = params.id ?? newId("scene");
  if (entryOf(draft.state.scenes, id)) fail("id-taken", { kind: "scene", id, by: "scene" });
  for (const name of Object.keys(files)) {
    const path = SourcePath.safeParse(sceneFile(id, name));
    if (!path.success) formatFailure(path.error, `files.${name}`);
  }
  draft.set(["scenes", id], scene);
  for (const [name, text] of Object.entries(files)) {
    const path = sceneFile(id, name);
    checkWrite(draft.state, path, text);
    draft.setText(["files", path], text);
  }
  assertManifest(id, scene, draft.state.files);
  return { id };
}

const ClearableSceneField = z.enum(["description", "params", "presets", "tags"]);

export const SceneUpdate = z.strictObject({
  scene: Id,
  changes: SceneManifest.partial(),
  clear: z.array(ClearableSceneField).optional(),
});

function sceneOf(state: ProjectState, id: string): Manifest {
  return entryOf(state.scenes, id) ?? fail("not-found", { kind: "scene", id });
}

export function updateScene(draft: Draft, params: z.output<typeof SceneUpdate>): void {
  const { scene: id, changes, clear } = params;
  const current = sceneOf(draft.state, id);
  const next: Record<string, unknown> = { ...current, ...changes };
  for (const field of clear ?? []) delete next[field];
  const result = SceneManifest.safeParse(next);
  if (!result.success) return formatFailure(result.error, "changes");
  assertManifest(id, result.data, draft.state.files);
  draft.replace(["scenes", id], result.data);
}

/** `withUses` takes the clips that use it along, in the same step, see `removeUses`. */
export const SceneRemove = z.strictObject({ scene: Id, withUses: z.boolean().optional() });

/** Its files go along: nothing else can reach them. */
export function removeScene(draft: Draft, { scene, withUses }: z.output<typeof SceneRemove>): void {
  sceneOf(draft.state, scene);
  if (withUses) removeUses(draft, "scene", scene);
  else assertSceneUnused(draft.state, scene);
  const folder = sceneFile(scene, "");
  for (const path of Object.keys(draft.state.files)) {
    if (path.startsWith(folder)) draft.delete(["files", path]);
  }
  draft.delete(["scenes", scene]);
}

export const SoundAdd = z.strictObject({
  id: Id.optional(),
  /** What the sound is, as its `sound.json` says. */
  manifest: SoundManifest,
  /** By path in the folder of the sound. */
  files: z.record(RelativePath, z.string()),
});

/** A sound with its files. An entry that is not there is a sound that can never be made. */
export function addSound(draft: Draft, params: z.output<typeof SoundAdd>): { id: string } {
  const { manifest: sound, files } = params;
  const id = params.id ?? newId("sound");
  if (entryOf(draft.state.sounds, id)) fail("id-taken", { kind: "sound", id, by: "sound" });
  for (const name of Object.keys(files)) {
    const path = SourcePath.safeParse(soundFile(id, name));
    if (!path.success) formatFailure(path.error, `files.${name}`);
  }
  draft.set(["sounds", id], sound);
  for (const [name, text] of Object.entries(files)) {
    const path = soundFile(id, name);
    checkWrite(draft.state, path, text);
    draft.setText(["files", path], text);
  }
  assertSoundManifest(id, sound, draft.state.files);
  return { id };
}

const ClearableSoundField = z.enum(["description", "params", "outputs", "tags"]);

export const SoundUpdate = z.strictObject({
  sound: Id,
  changes: SoundManifest.partial(),
  clear: z.array(ClearableSoundField).optional(),
});

function soundOf(state: ProjectState, id: string): SoundManifestType {
  return entryOf(state.sounds, id) ?? fail("not-found", { kind: "sound", id });
}

export function updateSound(draft: Draft, params: z.output<typeof SoundUpdate>): void {
  const { sound: id, changes, clear } = params;
  const current = soundOf(draft.state, id);
  const next: Record<string, unknown> = { ...current, ...changes };
  for (const field of clear ?? []) delete next[field];
  const result = SoundManifest.safeParse(next);
  if (!result.success) return formatFailure(result.error, "changes");
  assertSoundManifest(id, result.data, draft.state.files);
  draft.replace(["sounds", id], result.data);
}

/** `withUses` takes the clips that use it along, in the same step, see `removeUses`. */
export const SoundRemove = z.strictObject({ sound: Id, withUses: z.boolean().optional() });

/** Its files go along: nothing else can reach them. */
export function removeSound(draft: Draft, { sound, withUses }: z.output<typeof SoundRemove>): void {
  soundOf(draft.state, sound);
  if (withUses) removeUses(draft, "sound", sound);
  else if (isInUse(draft.state, ["sounds", sound])) {
    fail("sound-in-use", { sound });
  }
  const folder = soundFile(sound, "");
  for (const path of Object.keys(draft.state.files)) {
    if (path.startsWith(folder)) draft.delete(["files", path]);
  }
  draft.delete(["sounds", sound]);
}

export const FileWrite = z.strictObject({ path: SourcePath, text: z.string() });

/** What did not change writes nothing, so that saving the same text leaves no step to undo. */
export function writeFile(draft: Draft, { path, text }: z.output<typeof FileWrite>): void {
  checkWrite(draft.state, path, text);
  if (entryOf(draft.state.files, path) !== text) draft.setText(["files", path], text);
}

/** The scene or sound that starts with this file. It would never run again without it. */
function startsWith(state: ProjectState, path: string): string | undefined {
  const owner = ownerOf(path);
  if (owner.kind === "code") return undefined;
  const manifest = entryOf(owner.kind === "scene" ? state.scenes : state.sounds, owner.id);
  return manifest?.entry === owner.rest.join("/") ? owner.id : undefined;
}

export const FileRemove = z.strictObject({ path: SourcePath });

export function removeFile(draft: Draft, { path }: z.output<typeof FileRemove>): void {
  const { state } = draft;
  if (entryOf(state.files, path) === undefined) fail("not-found", { kind: "file", id: path });
  if (startsWith(state, path)) fail("entry-in-use", { path, why: "remove" });
  draft.delete(["files", path]);
}

export const FileRename = z.strictObject({ from: SourcePath, to: SourcePath });

/** An entry stays the entry. It cannot leave its scene that way, because the scene would have none. */
export function renameFile(draft: Draft, { from, to }: z.output<typeof FileRename>): void {
  const { state } = draft;
  const text = entryOf(state.files, from) ?? fail("not-found", { kind: "file", id: from });
  if (from === to) return;
  if (entryOf(state.files, to) !== undefined) fail("path-taken", { path: to, by: "file" });
  const owner = startsWith(state, from);
  const source = ownerOf(from);
  const target = ownerOf(to);
  // An entry stays the entry of what it starts, a scene or a sound, so it stays in that folder.
  const stays = target.kind === source.kind && target.kind !== "code" && target.id === owner;
  if (owner !== undefined && !stays) fail("entry-in-use", { path: from, why: "move" });
  draft.delete(["files", from]);
  checkWrite(draft.state, to, text);
  draft.setText(["files", to], text);
  if (owner === undefined || target.kind === "code") return;
  const entry = target.rest.join("/");
  if (target.kind === "scene") updateScene(draft, { scene: owner, changes: { entry } });
  else updateSound(draft, { sound: owner, changes: { entry } });
}

function assertSceneUnused(state: ProjectState, scene: string): void {
  if (isInUse(state, ["scenes", scene])) {
    fail("scene-in-use", { scene });
  }
}
