import { describe, expect, it } from "vitest";
import type { ClipState } from "../model.ts";
import { describeClip } from "../objects.ts";
import { staticProblems } from "./static.ts";
import { TONE, audio, clip, color, stateOf, tone, video } from "./test-support.ts";

const CLIPS = 1000;
/** What a change may cost: it is worked out again after each burst of them, and after each batch of AI. */
const LIMIT_MS = 20;

describe("the problems that the project alone tells", () => {
  it(`take less than ${LIMIT_MS} ms for ${CLIPS} clips`, () => {
    const at = (index: number) => ({ start: String(index * 2), duration: "2" });
    const pictures = Array.from({ length: CLIPS / 2 }, (_, index) =>
      index % 3 === 0
        ? clip(
            `s${index}`,
            { kind: "scene", scene: "a" },
            { ...at(index), properties: { "object.arm.x": 1 } },
          )
        : color(`c${index}`, {
            ...at(index),
            properties: { opacity: 0.5 },
            ...(index % 7 === 0 && { draft: true }),
          }),
    );
    const sounds = Array.from({ length: CLIPS / 2 }, (_, index) =>
      tone(`t${index}`, {
        ...at(index),
        properties: { "audio.volume": -6, ...(index % 5 === 0 && { "audio.pan": 0.5 }) },
      }),
    );
    const state = stateOf({
      tracks: [video(pictures), audio(sounds)],
      assets: TONE,
      scenes: { a: { name: "场景", entry: "index.html", runtime: 1 } as never },
      files: { "scenes/a/index.html": "<p>a</p>" },
    });
    const inputs = { describe: (each: ClipState) => describeClip(state, each, undefined) };
    expect(staticProblems(state, inputs).length).toBeGreaterThan(100);
    const times: number[] = [];
    for (let round = 0; round < 15; round += 1) {
      const started = performance.now();
      staticProblems(state, inputs);
      times.push(performance.now() - started);
    }
    const median = times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0;
    console.log(`static problems of ${CLIPS} clips: median ${median.toFixed(2)} ms`);
    expect(median).toBeLessThan(LIMIT_MS);
  });
});
