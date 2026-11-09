import type { RenderLayer } from "@animaquill/core";
import { fileTimeOf, readingAt, VideoCursor, type FrameSource, type TimedFrame } from "./cursor.ts";

interface Entry<Frame extends TimedFrame> {
  readonly file: string;
  readonly cursor: VideoCursor<Frame>;
}

/** Finding a layer by id for each read, many times a second, should not go through the whole plan. */
const byId = new WeakMap<readonly RenderLayer[], ReadonlyMap<string, RenderLayer>>();
function layerById(layers: readonly RenderLayer[], id: string): RenderLayer | undefined {
  let found = byId.get(layers);
  if (!found) {
    found = new Map(layers.map((layer) => [layer.id, layer]));
    byId.set(layers, found);
  }
  return found.get(id);
}

/**
 * The videos being read, by clip, because two clips of one file read different places. Drawing a
 * frame and getting the next clips ready both read through these.
 */
export class VideoReads<Frame extends TimedFrame> {
  readonly #entries = new Map<string, Entry<Frame>>();

  /** The cursor of a clip. Another file for the clip, as after a change, starts a new one. */
  async cursorOf(layer: string, file: string, source: FrameSource<Frame>) {
    let entry = this.#entries.get(layer);
    if (entry?.file !== file) {
      await entry?.cursor.close();
      entry = { file, cursor: new VideoCursor(source) };
      this.#entries.set(layer, entry);
    }
    return entry.cursor;
  }

  /** The frame of a clip at a moment, and whether decoding had to start at a keyframe for it. */
  async frameAt(
    layer: RenderLayer,
    file: string,
    source: FrameSource<Frame>,
    seconds: number,
  ): Promise<{ readonly frame: Frame | undefined; readonly cold: boolean }> {
    const cursor = await this.cursorOf(layer.id, file, source);
    const frame = await cursor.at(fileTimeOf(layer, seconds));
    return { frame, cold: cursor.takeCold() };
  }

  /** Gets a clip that comes up soon ready, with the playhead at a moment: up to its first frame. */
  async prepare(
    layer: RenderLayer,
    file: string,
    source: FrameSource<Frame>,
    seconds: number,
  ): Promise<void> {
    const cursor = await this.cursorOf(layer.id, file, source);
    const reading = readingAt(layer, seconds);
    if (reading !== undefined) await cursor.at(reading);
    // Starting there is what getting ready is for, and no frame waited for it.
    cursor.takeCold();
  }

  /** The files that something reads, which must stay open. */
  files(): Set<string> {
    return new Set([...this.#entries.values()].map(({ file }) => file));
  }

  /** A decoder is a scarce thing, so a clip that left the picture gives its own back. */
  async closeExcept(keep: ReadonlySet<string>): Promise<void> {
    for (const [id, { cursor }] of this.#entries) {
      if (keep.has(id)) continue;
      this.#entries.delete(id);
      await cursor.close();
    }
  }

  /** Lets go of what reads a file, which changed: the next read starts over from what is there now. */
  forget(file: string): Promise<void> {
    const reading = [...this.#entries].filter(([, entry]) => entry.file === file);
    for (const [layer] of reading) this.#entries.delete(layer);
    return Promise.all(reading.map(([, { cursor }]) => cursor.close().catch(() => {}))).then(
      () => {},
    );
  }

  /**
   * Gives up reads that do not lead to where the playhead is, see `giveUpUnlessLeadsTo`. A clip that
   * is not in the plan any more leads nowhere. Says which clips gave up a read.
   */
  giveUpFor(layers: readonly RenderLayer[], seconds: number): string[] {
    const gaveUp: string[] = [];
    for (const [id, { cursor }] of this.#entries) {
      const layer = layerById(layers, id);
      if (cursor.giveUpUnlessLeadsTo(layer && readingAt(layer, seconds))) gaveUp.push(id);
    }
    return gaveUp;
  }
}
