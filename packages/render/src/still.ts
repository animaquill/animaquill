import type { RenderLayer } from "@animaquill/core";
import { opacityAt } from "@animaquill/core/view";
import type { SceneStatus } from "./index.ts";

/** Why there is no picture of a moment. There is never a picture with something missing in it. */
export type StillFailure =
  /** The editor does not have the file of this clip. */
  | { readonly reason: "missing-file"; readonly layer: string; readonly file: string }
  | { readonly reason: "cannot-decode"; readonly layer: string; readonly file: string }
  /** The scene of this clip is not running, and what is left of it is a placeholder. */
  | { readonly reason: "scene"; readonly layer: string; readonly status: SceneStatus }
  /** The scene says it got to the frame, and its picture of that frame never came. */
  | {
      readonly reason: "scene-frame";
      readonly layer: string;
      readonly wanted: number;
      /** The frame of the picture it does have. */
      readonly got?: number;
    }
  /** The compositor stopped answering. */
  | { readonly reason: "compositor" }
  /** Drawing or reading back went wrong, which says something about the browser. */
  | { readonly reason: "failed"; readonly message: string };

export class StillFailed extends Error {
  readonly failure: StillFailure;

  constructor(failure: StillFailure) {
    super(`No still: ${failure.reason}`);
    this.failure = failure;
  }
}

export const failureOf = (error: unknown): StillFailure =>
  error instanceof StillFailed
    ? error.failure
    : { reason: "failed", message: error instanceof Error ? error.message : String(error) };

/**
 * Files that take the editor a moment. The preview draws what it has and draws again when the rest
 * comes, and a picture that goes out into the world only gets one chance.
 */
export class FileArrivals {
  readonly #waiting = new Map<string, PromiseWithResolvers<Blob | undefined>>();

  /** Resolves to undefined when the editor says that it does not have the file. */
  wait(id: string): Promise<Blob | undefined> {
    let waiting = this.#waiting.get(id);
    if (!waiting) {
      waiting = Promise.withResolvers();
      this.#waiting.set(id, waiting);
    }
    return waiting.promise;
  }

  settle(id: string, file: Blob | undefined): void {
    this.#waiting.get(id)?.resolve(file);
    this.#waiting.delete(id);
  }
}

/** What a strict picture is made from. What it gives is for the caller to draw and to close. */
export interface StillSources<Picture extends { close(): void }> {
  /** Resolves when the file is here, to undefined when it is not going to be. */
  file(id: string): Promise<Blob | undefined>;
  /** Resolves to undefined, or rejects, when the file cannot be read. */
  image(layer: RenderLayer, id: string, file: Blob): Promise<Picture | undefined>;
  video(layer: RenderLayer, id: string, file: Blob): Promise<Picture | undefined>;
  /** The picture of the frame the scene has to be on. Rejects with `StillFailed` if there is none. */
  scene(layer: RenderLayer): Promise<Picture>;
}

async function pictureFor<Picture extends { close(): void }>(
  layer: RenderLayer,
  seconds: number,
  sources: StillSources<Picture>,
): Promise<Picture | undefined> {
  const { source } = layer;
  // Nothing of it reaches the picture, so nothing about it can be wrong with the picture.
  if (source.kind === "color" || opacityAt(layer, seconds) <= 0) return undefined;
  if (source.kind === "scene") return sources.scene(layer);
  const { file: id } = source;
  const file = await sources.file(id);
  if (!file) throw new StillFailed({ reason: "missing-file", layer: layer.id, file: id });
  const read = source.kind === "image" ? sources.image : sources.video;
  const picture = await read(layer, id, file).catch(() => undefined);
  if (!picture) throw new StillFailed({ reason: "cannot-decode", layer: layer.id, file: id });
  return picture;
}

/**
 * Everything a moment needs, by layer, or a failure and nothing at all. Undefined is for what takes
 * no picture. It waits for all of them, because what did arrive has to be closed again.
 */
export async function stillPictures<Picture extends { close(): void }>(
  layers: readonly RenderLayer[],
  seconds: number,
  sources: StillSources<Picture>,
): Promise<readonly (Picture | undefined)[]> {
  const all = await Promise.allSettled(layers.map((layer) => pictureFor(layer, seconds, sources)));
  const failed = all.find((result) => result.status === "rejected");
  if (!failed)
    return all.map((result) => (result.status === "fulfilled" ? result.value : undefined));
  for (const result of all) if (result.status === "fulfilled") result.value?.close();
  throw failed.reason;
}
