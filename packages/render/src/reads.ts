import type { RenderLayer } from "@animaquill/core";
import { fileTimeOf, readingAt, VideoCursor, type FrameSource, type TimedFrame } from "./cursor.ts";

interface Entry<Frame extends TimedFrame> {
  readonly file: string;
  /** What it reads from: another one for the same file, as a stand-in, is another read. */
  readonly source: FrameSource<Frame>;
  readonly cursor: VideoCursor<Frame>;
  /** The cursor this one took the place of has given its decoder back. */
  readonly ready: Promise<void>;
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

const done = Promise.resolve();

/**
 * The videos being read, by clip, because two clips of one file read different places. Drawing a
 * frame and getting the next clips ready both read through these.
 */
export class VideoReads<Frame extends TimedFrame> {
  readonly #entries = new Map<string, Entry<Frame>>();

  /**
   * The cursor of a clip. Another file for the clip, as after a change, starts a new one, and so
   * does another source of the same file: a frame that was on its way when a stand-in took the
   * place of a video still reads the video, and what comes after it must not go on from there.
   *
   * The new cursor takes the place of the old one before anything waits: drawing a frame and getting
   * the clip ready often ask at once, after the same file opened, and a second cursor made meanwhile
   * would be one nothing closes, with its frames and its decoder. Both wait for the old one to close.
   */
  async cursorOf(layer: string, file: string, source: FrameSource<Frame>) {
    let entry = this.#entries.get(layer);
    if (entry?.file !== file || entry.source !== source) {
      const old = entry?.cursor;
      entry = {
        file,
        source,
        cursor: new VideoCursor(source),
        ready: old ? old.close().catch(() => {}) : done,
      };
      this.#entries.set(layer, entry);
    }
    await entry.ready;
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
