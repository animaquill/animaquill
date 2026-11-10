import { describe, expect, it } from "vitest";
import { SlowVideos, type VideoRead } from "./slow-videos.ts";

const FRAME_MS = 1000 / 30;

const read = (file: string, ms: number, standIn = false): VideoRead => ({ file, ms, standIn });

/** Plays frames that reach the screen this many milliseconds apart, and says what was said. */
function play(
  slow: SlowVideos,
  frames: number,
  each: (index: number) => { gap: number; behindMs: number; videos: VideoRead[] },
  from = 0,
): string[] {
  const said: string[] = [];
  let at = from;
  for (let index = 0; index < frames; index += 1) {
    const { gap, behindMs, videos } = each(index);
    at += gap;
    said.push(...slow.note({ at, frameMs: FRAME_MS, behindMs, videos }));
  }
  return said;
}

describe("videos that decode too slowly to keep up", () => {
  it("are said once frames late because of them took half of the last two seconds", () => {
    const slow = new SlowVideos();
    // Every other frame comes three frames late, and the 4K video took that long for it.
    const said = play(slow, 90, (index) =>
      index % 2 === 1
        ? { gap: 100, behindMs: 100, videos: [read("4k", 100), read("hd", 5)] }
        : { gap: FRAME_MS, behindMs: 0, videos: [read("4k", 10), read("hd", 5)] },
    );
    expect(said).toEqual(["4k"]);
  });

  it("are said also when so few frames come that they could not be counted", () => {
    const slow = new SlowVideos();
    const said = play(slow, 4, () => ({ gap: 800, behindMs: 800, videos: [read("4k", 790)] }));
    expect(said).toEqual(["4k"]);
  });

  it("are said also when each frame takes longer than the two seconds, as on a busy computer", () => {
    const slow = new SlowVideos();
    // As the preview of a slow video went on a busy machine: four frames in six seconds.
    const gaps = [FRAME_MS, 1135, 3888, 432];
    const said = play(slow, gaps.length, (index) => {
      const gap = gaps[index] ?? 0;
      return { gap, behindMs: gap, videos: [read("4k", gap - 4)] };
    });
    expect(said).toEqual(["4k"]);
  });

  it("count the time since the frame before, also when that one had no video", () => {
    const slow = new SlowVideos();
    // The video keeps up, then something else plays for a second and a half, and then the video is
    // late once by a few frames: that was a moment, not the second and a half.
    const said = play(slow, 56, (index) =>
      index < 10
        ? { gap: FRAME_MS, behindMs: 0, videos: [read("4k", 5)] }
        : index < 55
          ? { gap: FRAME_MS, behindMs: 0, videos: [] }
          : { gap: 100, behindMs: 100, videos: [read("4k", 90)] },
    );
    expect(said).toEqual([]);
  });

  it("are not said before a second and a half of playing", () => {
    const slow = new SlowVideos();
    const said = play(slow, 10, () => ({ gap: 100, behindMs: 100, videos: [read("4k", 90)] }));
    expect(said).toEqual([]);
  });

  it("are not the ones that were quick while something else made the frame late", () => {
    const slow = new SlowVideos();
    const said = play(slow, 100, () => ({ gap: 200, behindMs: 200, videos: [read("quick", 8)] }));
    expect(said).toEqual([]);
  });

  it("are not the ones that took long while the picture kept up anyway", () => {
    const slow = new SlowVideos();
    const said = play(slow, 100, () => ({ gap: FRAME_MS, behindMs: 0, videos: [read("x", 50)] }));
    expect(said).toEqual([]);
  });

  it("are not said for a cut now and then", () => {
    const slow = new SlowVideos();
    // A keyframe to start from every half a second, which holds the picture back by a frame.
    const said = play(slow, 300, (index) =>
      index % 15 === 0
        ? { gap: 70, behindMs: 40, videos: [read("4k", 60)] }
        : { gap: FRAME_MS, behindMs: 0, videos: [read("4k", 12)] },
    );
    expect(said).toEqual([]);
  });

  it("start over after a pause", () => {
    const slow = new SlowVideos();
    const late = () => ({ gap: 300, behindMs: 300, videos: [read("4k", 300)] });
    expect(play(slow, 3, late)).toEqual([]);
    // Played again a minute later: what came before the pause is no part of it.
    slow.startOver();
    expect(play(slow, 3, late, 60_000)).toEqual([]);
  });

  it("are never a copy that stands in for a video", () => {
    const slow = new SlowVideos();
    const said = play(slow, 100, () => ({
      gap: 200,
      behindMs: 200,
      videos: [read("4k", 150, true)],
    }));
    expect(said).toEqual([]);
  });

  it("count each video once in a frame, by its slowest picture", () => {
    const slow = new SlowVideos();
    const said = play(slow, 20, () => ({
      gap: 100,
      behindMs: 100,
      videos: [read("4k", 10), read("4k", 90)],
    }));
    expect(said).toEqual(["4k"]);
  });
});
