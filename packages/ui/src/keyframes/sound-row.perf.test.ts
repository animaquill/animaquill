import type { MixSound } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import { paintSoundLevels, soundLevels } from "./sound-row.ts";

const TRACKS = 20;
const HOUR = 3600;
/** Clips of a minute, each with a file of its own. */
const CLIP = 60;
const WIDTH = 1600;
/** What a frame may take, for the row of sound alone. */
const FRAME_BUDGET_MS = 4;

/** A context without a canvas, so that what is measured is the work of the row itself. */
const context = {
  fillStyle: "",
  beginPath() {},
  rect() {},
  fill() {},
} as unknown as CanvasRenderingContext2D;

describe("the row of sound on a long timeline", () => {
  it("draws an hour of twenty tracks within a frame while scrolling and zooming", () => {
    let seed = 3;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const files = new Map<string, Uint8Array>();
    const sounds: MixSound[] = [];
    for (let track = 0; track < TRACKS; track += 1) {
      for (let start = 0; start < HOUR; start += CLIP) {
        const id = `${track}-${start}`;
        files.set(
          id,
          Uint8Array.from({ length: CLIP * 100 }, () => Math.floor(random() * 256)),
        );
        sounds.push({ id, file: id, start, end: start + CLIP, offset: 0, gain: 0.5, track: "t" });
      }
    }
    const peaksOf = (sound: MixSound) => files.get(sound.id);
    const levels = new Float32Array(WIDTH);
    const frame = (pixelsPerSecond: number, scrollX: number) => {
      const view = {
        width: WIDTH,
        timeAt: (x: number) => (x + scrollX) / pixelsPerSecond,
        xAt: (seconds: number) => seconds * pixelsPerSecond - scrollX,
      };
      const begun = performance.now();
      soundLevels(
        { sounds, tracks: [{ id: "t", gain: 1, muted: false, solo: false }] },
        peaksOf,
        view,
        levels,
      );
      paintSoundLevels(context, levels, WIDTH, { top: 24, height: 48 }, "#3f9a7a");
      return performance.now() - begun;
    };
    // The first look at each file builds what it is looked up in, once, as the waveform arrives.
    frame(WIDTH / HOUR, 0);
    const times: number[] = [];
    // Zooming from all of it in to a few seconds, and scrolling at each step.
    for (let scale = WIDTH / HOUR; scale < 2000; scale *= 1.25) {
      const content = HOUR * scale;
      for (let step = 0; step < 8; step += 1) {
        times.push(frame(scale, Math.max(content - WIDTH, 0) * (step / 7)));
      }
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] as number;
    const worst = times[Math.floor(times.length * 0.95)] as number;
    console.log(
      `row of sound: ${times.length} frames, median ${median.toFixed(2)} ms, 95th ${worst.toFixed(2)} ms`,
    );
    expect(worst).toBeLessThan(FRAME_BUDGET_MS);
  });
});
