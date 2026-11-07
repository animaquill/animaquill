import {
  CURRENT_SCENE_RUNTIME,
  Id,
  RelativePath,
  SceneManifest,
  newId,
  type SceneManifest as Manifest,
} from "@animaquill/schema";
import { z } from "zod";
import { fail, type Draft } from "./draft.ts";
import { isSourceFile } from "./import-file.ts";
import { entryOf, type ProjectState } from "./model.ts";
import { isInUse, isOnLockedTrack, runsOnLockedTrack } from "./references.ts";

declare const TextEncoder: new () => { encode(text: string): Uint8Array };

/** A browser handles more than this badly, and a file that size is not code anybody writes. */
export const MAX_SOURCE_BYTES = 32 * 1024 ** 2;

/** Bytes per character at the most, in UTF-8. */
const MOST_BYTES_PER_CHARACTER = 3;

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

/**
 * Nobody can be sure what a locked track shows if what it runs changes, so that protects it as much
 * as a change to the clip would. Shared code can be behind anything, so all of it counts.
 */
function assertSourceEditable(state: ProjectState, path: string): void {
  const owner = ownerOf(path);
  if (owner.kind === "code") {
    if (runsOnLockedTrack(state)) fail("track-locked", "锁定的轨道上有场景或声音，共用代码不能改");
    return;
  }
  const target = [owner.kind === "scene" ? "scenes" : "sounds", owner.id];
  if (isOnLockedTrack(state, target)) fail("track-locked", `锁定的轨道上在用：${owner.id}`);
}

/** The folder has to be there: a file nothing can reach is a mistake, and the check finds it now. */
function assertOwnerExists(state: ProjectState, path: string): void {
  const owner = ownerOf(path);
  if (owner.kind === "code") return;
  const known = owner.kind === "scene" ? state.scenes : state.sounds;
  if (!entryOf(known, owner.id)) fail("not-found", `没有这个文件夹：${owner.id}`);
}

function assertSize(path: string, text: string): void {
  if (text.length * MOST_BYTES_PER_CHARACTER <= MAX_SOURCE_BYTES) return;
  if (new TextEncoder().encode(text).length > MAX_SOURCE_BYTES) {
    fail("file-too-large", `文件不能超过 32 MiB：${path}`);
  }
}

/** A folder and a file of one name cannot live next to each other once the project is a folder. */
function assertFits(state: ProjectState, path: string): void {
  const parts = path.split("/");
  for (let length = 1; length < parts.length; length += 1) {
    const folder = parts.slice(0, length).join("/");
    if (entryOf(state.files, folder) !== undefined)
      fail("path-taken", `这里已经有文件了：${folder}`);
  }
  const inside = `${path}/`;
  if (Object.keys(state.files).some((file) => file.startsWith(inside))) {
    fail("path-taken", `这里已经有文件夹了：${path}`);
  }
}

/** What every write of a file goes through, before anything gets written. */
function checkWrite(state: ProjectState, path: string, text: string): void {
  assertOwnerExists(state, path);
  assertSourceEditable(state, path);
  assertSize(path, text);
  if (entryOf(state.files, path) === undefined) assertFits(state, path);
}

const sceneFile = (id: string, entry: string) => `scenes/${id}/${entry}`;

function assertManifest(id: string, scene: Manifest, files: ProjectState["files"]): void {
  if (scene.runtime > CURRENT_SCENE_RUNTIME) {
    fail("runtime-too-new", `这个编辑器只有运行时版本 ${CURRENT_SCENE_RUNTIME}，要先更新编辑器`);
  }
  if (entryOf(files, sceneFile(id, scene.entry)) === undefined) {
    fail("missing-entry", `场景的入口文件不在：${scene.entry}`);
  }
}

export const SceneAdd = z.strictObject({
  id: Id.optional(),
  scene: SceneManifest,
  /** By path in the folder of the scene. Scenes hold text: pictures and such are assets. */
  files: z.record(RelativePath, z.string()),
});

/** A scene with its files. An entry that is not there is a scene that can never run. */
export function addScene(draft: Draft, params: z.output<typeof SceneAdd>): { id: string } {
  const { scene, files } = params;
  const id = params.id ?? newId("scene");
  if (entryOf(draft.state.scenes, id)) fail("id-taken", `这个 ID 已经有场景了：${id}`);
  const paths = Object.keys(files).map((name) => SourcePath.safeParse(sceneFile(id, name)));
  for (const path of paths) {
    if (!path.success) fail("invalid-value", path.error.issues[0]?.message ?? "路径不对");
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

const ClearableSceneField = z.enum(["description", "params", "presets"]);

export const SceneUpdate = z.strictObject({
  scene: Id,
  changes: SceneManifest.partial(),
  clear: z.array(ClearableSceneField).optional(),
});

function sceneOf(state: ProjectState, id: string): Manifest {
  return entryOf(state.scenes, id) ?? fail("not-found", `没有这个场景：${id}`);
}

export function updateScene(draft: Draft, params: z.output<typeof SceneUpdate>): void {
  const { scene: id, changes, clear } = params;
  const current = sceneOf(draft.state, id);
  assertSourceEditable(draft.state, sceneFile(id, "scene.json"));
  const next: Record<string, unknown> = { ...current, ...changes };
  for (const field of clear ?? []) delete next[field];
  const result = SceneManifest.safeParse(next);
  if (!result.success) {
    const issue = result.error.issues[0];
    return fail("invalid-value", `${issue?.path.join(".")}：${issue?.message}`);
  }
  assertManifest(id, result.data, draft.state.files);
  draft.replace(["scenes", id], result.data);
}

export const SceneRemove = z.strictObject({ scene: Id });

/** Its files go along: nothing else can reach them. */
export function removeScene(draft: Draft, { scene }: z.output<typeof SceneRemove>): void {
  sceneOf(draft.state, scene);
  assertSceneUnused(draft.state, scene);
  const folder = sceneFile(scene, "");
  for (const path of Object.keys(draft.state.files)) {
    if (path.startsWith(folder)) draft.delete(["files", path]);
  }
  draft.delete(["scenes", scene]);
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
  if (entryOf(state.files, path) === undefined) fail("not-found", `没有这个文件：${path}`);
  assertSourceEditable(state, path);
  if (startsWith(state, path)) fail("entry-in-use", `这是入口文件，要先换一个入口：${path}`);
  draft.delete(["files", path]);
}

export const FileRename = z.strictObject({ from: SourcePath, to: SourcePath });

/** An entry stays the entry. It cannot leave its scene that way, because the scene would have none. */
export function renameFile(draft: Draft, { from, to }: z.output<typeof FileRename>): void {
  const { state } = draft;
  const text = entryOf(state.files, from) ?? fail("not-found", `没有这个文件：${from}`);
  if (from === to) return;
  if (entryOf(state.files, to) !== undefined) fail("path-taken", `这里已经有文件了：${to}`);
  assertSourceEditable(state, from);
  const owner = startsWith(state, from);
  const target = ownerOf(to);
  const stays = target.kind === "scene" && target.id === owner;
  if (owner !== undefined && !stays) fail("entry-in-use", `入口文件不能移出它的文件夹：${from}`);
  draft.delete(["files", from]);
  checkWrite(draft.state, to, text);
  draft.setText(["files", to], text);
  if (owner !== undefined && target.kind === "scene") {
    updateScene(draft, { scene: owner, changes: { entry: target.rest.join("/") } });
  }
}

function assertSceneUnused(state: ProjectState, scene: string): void {
  if (isInUse(state, ["scenes", scene])) {
    fail("scene-in-use", "还有片段或版本在用这个场景，要先换掉或删除它们");
  }
}
