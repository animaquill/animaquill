import { Id } from "@animaquill/schema";
import { z } from "zod";
import { clipPath, removeClips, timelinePath } from "./clip-edits.ts";
import { fail, type Draft } from "./draft.ts";
import { entryOf, type ProjectState } from "./model.ts";
import { sourceResourceOf } from "./uses.ts";

/**
 * What happens to the clips that use a resource of the project when it goes or another takes its
 * place: for the explorer, and for AI, which can do the same. See docs/design/resource-panels.md.
 */

/** The resources of a project that clips take their content from. */
export const SourceResourceKind = z.enum(["asset", "scene", "sound"]);
type SourceResourceKind = z.output<typeof SourceResourceKind>;

const TOP: Readonly<Record<SourceResourceKind, "assets" | "scenes" | "sounds">> = {
  asset: "assets",
  scene: "scenes",
  sound: "sounds",
};

const NAMES: Readonly<Record<SourceResourceKind, string>> = {
  asset: "素材",
  scene: "场景",
  sound: "声音",
};

const has = (state: ProjectState, kind: SourceResourceKind, id: string) =>
  entryOf(state[TOP[kind]] as Readonly<Record<string, unknown>> | undefined, id) !== undefined;

const isIt = (source: unknown, kind: SourceResourceKind, id: string) => {
  const found = sourceResourceOf(source);
  return found?.kind === kind && found.id === id;
};

/**
 * Takes away every clip that uses a resource, and what versions change about other clips to use
 * it, so that the resource can go in the same step. Joins of the clips go with them.
 */
export function removeUses(draft: Draft, kind: SourceResourceKind, id: string): void {
  for (const [timeline, { clips, overrides }] of Object.entries(draft.state.timelines)) {
    const using = Object.values(clips).flatMap((clip) =>
      isIt(clip.source, kind, id) ? [clip.id] : [],
    );
    const gone = new Set(using);
    for (const [version, { clips: changed }] of Object.entries(overrides)) {
      for (const [clip, changes] of Object.entries(changed ?? {})) {
        if (gone.has(clip) || !changes.source || !isIt(changes.source.value, kind, id)) continue;
        const path = [...timelinePath(timeline), "overrides", version, "clips", clip, "source"];
        draft.delete(path);
      }
    }
    if (using.length > 0) removeClips(draft, timeline, using);
  }
}

/** Which kinds of assets a clip of a kind can show. The sound of a video is the sound of it. */
const ASSET_KINDS: Readonly<Record<string, readonly string[]>> = {
  video: ["video"],
  image: ["image"],
  audio: ["audio", "video"],
};

export const SourceReplace = z.strictObject({
  kind: SourceResourceKind,
  /** What clips use now. It need not be there, as when a file took it away. */
  from: Id,
  to: Id,
});

/** Another source for a clip, with `to` where it had `from`. */
function replaced(source: unknown, kind: SourceResourceKind, to: string): unknown {
  const value = source as Record<string, unknown>;
  if (kind === "asset") {
    return { ...value, media: { ...(value.media as Record<string, unknown>), asset: to } };
  }
  return { ...value, [kind]: to };
}

/**
 * Every clip that uses a resource uses another one of the same kind instead, and so do versions:
 * for a resource that is missing, or one that people would rather have. Everything else about the
 * clips stays as it is.
 */
export function replaceSource(
  draft: Draft,
  { kind, from, to }: z.output<typeof SourceReplace>,
): { readonly clips: number } {
  const { state } = draft;
  if (from === to) fail("invalid-value", `换成的${NAMES[kind]}和原来的是同一个：${to}`);
  if (!has(state, kind, to)) fail("not-found", `没有这个${NAMES[kind]}：${to}`);
  const asset = kind === "asset" ? entryOf(state.assets, to) : undefined;
  const fits = (source: unknown) => {
    if (!asset) return true;
    const clipKind = (source as { readonly kind?: string }).kind ?? "";
    return ASSET_KINDS[clipKind]?.includes(asset.kind) ?? false;
  };
  const changes: { readonly path: readonly string[]; readonly value: unknown }[] = [];
  let clips = 0;
  for (const [timeline, { clips: all, overrides }] of Object.entries(state.timelines)) {
    for (const clip of Object.values(all)) {
      if (!isIt(clip.source, kind, from)) continue;
      if (!fits(clip.source)) {
        fail("invalid-value", `片段 ${clip.id} 是${clip.source.kind}，用不了这种素材：${to}`);
      }
      changes.push({
        path: [...clipPath(timeline, clip.id), "source"],
        value: replaced(clip.source, kind, to),
      });
      clips += 1;
    }
    for (const [version, { clips: changed }] of Object.entries(overrides)) {
      for (const [clip, override] of Object.entries(changed ?? {})) {
        const source = override.source?.value;
        if (!override.source || !isIt(source, kind, from)) continue;
        if (!fits(source)) {
          fail("invalid-value", `版本 ${version} 里的片段 ${clip} 用不了这种素材：${to}`);
        }
        const path = [...timelinePath(timeline), "overrides", version, "clips", clip, "source"];
        changes.push({ path, value: { ...override.source, value: replaced(source, kind, to) } });
      }
    }
  }
  if (changes.length === 0) fail("not-in-use", `没有片段在用这个${NAMES[kind]}：${from}`);
  for (const { path, value } of changes) draft.set(path, value);
  return { clips };
}
