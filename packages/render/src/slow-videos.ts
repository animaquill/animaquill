/** How long getting the picture of a video took for a frame, see `PendingFrame.videos`. */
export interface VideoRead {
  /** The id of the file, which is what the editor knows the video by. */
  readonly file: string;
  /** From asking for the frame until it was there, decoding and all. */
  readonly ms: number;
  /** What was read is a smaller copy that stands in for the video, see `ToCompositor` "file". */
  readonly standIn: boolean;
}

/** A frame asked for while playing that reached the screen, as far as videos go. */
export interface PlayedFrame {
  /** When it reached the screen, in milliseconds on any clock that goes on. */
  readonly at: number;
  /** How long a frame of the project lasts. */
  readonly frameMs: number;
  /** How far the playhead had moved on by the time the frame was drawn. */
  readonly behindMs: number;
  readonly videos: readonly VideoRead[];
}

/**
 * How much of the last moments of playing a video has to have held the picture back, see
 * `SlowVideos`: half of the last two seconds, of which at least one and a half went by.
 */
export const SLOW_RULES = { windowMs: 2000, seenMs: 1500, share: 0.5 } as const;

interface Seen {
  readonly at: number;
  /** How long the picture waited for this frame, since the one before. */
  readonly span: number;
  readonly late: boolean;
}

/**
 * Which videos decode too slowly for the preview to keep up while it plays, see the decision of
 * 2026-11-09: those get a proxy offered. By the frames that reached the screen:
 *
 * - Only frames while time goes on count. Whoever feeds this leaves out the rest.
 * - A frame is late because of a video when the playhead had moved on by at least a frame of the
 *   project by the time it was drawn, and getting the picture of that video alone took at least
 *   that long. A keyframe to start from at a cut, or getting the next clip ready at the same time,
 *   is part of that: a proxy makes both cheaper.
 * - The time the picture waited for each frame counts, since the frame before it while playing: a
 *   video decodes too slowly when, over the last two seconds of playing it, frames late because of
 *   it took at least half of the time. That is a stutter that goes on, not a cut now and then, also
 *   where so few frames come that they cannot be counted, and where one frame alone took longer
 *   than two seconds, as on a busy computer.
 * - Playing starts over after a pause, or after somebody moved the playhead: what came before says
 *   nothing about how it keeps up now. Whoever feeds this says so, see `startOver`. A frame asked
 *   for while playing counts also when playing stopped before it reached the screen.
 * - Each video is said once. A copy that stands in for a video is the best there is already.
 */
export class SlowVideos {
  /** The last frames of each video while playing, by file. */
  readonly #recent = new Map<string, Seen[]>();
  readonly #said = new Set<string>();
  /** When the frame before reached the screen, while playing since then. */
  #lastAt: number | undefined;

  /** Playing starts again, or the playhead moved: the next frame is the first of a new stretch. */
  startOver(): void {
    this.#recent.clear();
    this.#lastAt = undefined;
  }

  /**
   * Takes in a frame that was asked for while playing, also one without videos, and says
   * which videos turned out to decode too slowly with it.
   */
  note({ at, frameMs, behindMs, videos }: PlayedFrame): string[] {
    // However long ago the frame before was: a frame that took longer than the window waited all
    // that time, and that is what counts most.
    const span = this.#lastAt === undefined ? frameMs : at - this.#lastAt;
    this.#lastAt = at;
    const slowest = new Map<string, number>();
    for (const { file, ms, standIn } of videos) {
      if (standIn || this.#said.has(file)) continue;
      slowest.set(file, Math.max(ms, slowest.get(file) ?? 0));
    }
    const slow: string[] = [];
    const behind = behindMs >= frameMs;
    for (const [file, ms] of slowest) {
      // What is older than the window says nothing any more.
      const recent = (this.#recent.get(file) ?? []).filter(
        (seen) => seen.at > at - SLOW_RULES.windowMs,
      );
      recent.push({ at, span, late: behind && ms >= frameMs });
      this.#recent.set(file, recent);
      const seen = recent.reduce((sum, { span: each }) => sum + each, 0);
      const late = recent.reduce((sum, each) => sum + (each.late ? each.span : 0), 0);
      if (seen < SLOW_RULES.seenMs || late < seen * SLOW_RULES.share) continue;
      this.#said.add(file);
      this.#recent.delete(file);
      slow.push(file);
    }
    return slow;
  }
}
