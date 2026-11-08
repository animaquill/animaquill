import type { Page } from "@playwright/test";
import type { RenderJoin, RenderLayer, RenderPlan } from "@animaquill/core";
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import { content, expect, findCompositor, test } from "./support.ts";

/**
 * How the preview keeps up across a join of two videos, against one video on its own: both sides
 * of a join decode at the same time, and each gets a picture of its own before the join mixes them.
 * Measured as the compositor plays: what it says about each frame it drew, and how many it drew.
 * The numbers are what this is for, so it only fails when frames do not come at all.
 */

const SIZES = { "1080p": [1920, 1080], "4K": [3840, 2160] } as const;
const FPS = 30;
const SECONDS = 4;

test.setTimeout(600_000);

interface Encoded {
  readonly codec: string;
  readonly mime: string;
  readonly config: { readonly description?: string };
  readonly chunks: readonly { readonly data: string; readonly key: boolean }[];
}

/**
 * A moving picture of this size, encoded in the page as a camera would, for real decoding. Nothing
 * where this browser encodes none of the codecs tried.
 */
function encode(
  page: Page,
  size: readonly [number, number],
  count: number,
): Promise<Encoded | undefined> {
  return page.evaluate(
    async ({ width, height, frames, fps }) => {
      const candidates = [
        { codec: "avc1.640033", mime: "avc", avc: { format: "avc" } },
        { codec: "vp09.00.41.08", mime: "vp9" },
      ];
      const base64 = (bytes: Uint8Array) => {
        let text = "";
        for (let at = 0; at < bytes.length; at += 0x8000) {
          text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
        }
        return btoa(text);
      };
      for (const { mime, ...candidate } of candidates) {
        const config = { ...candidate, width, height, bitrate: 12e6, framerate: fps };
        const { supported } = await VideoEncoder.isConfigSupported(config as VideoEncoderConfig);
        if (!supported) continue;
        const chunks: { data: string; key: boolean }[] = [];
        let description: string | undefined;
        const encoder = new VideoEncoder({
          output: (chunk, meta) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            chunks.push({ data: base64(data), key: chunk.type === "key" });
            const given = meta?.decoderConfig?.description;
            if (given && description === undefined) {
              const view = ArrayBuffer.isView(given)
                ? new Uint8Array(given.buffer, given.byteOffset, given.byteLength)
                : new Uint8Array(given);
              description = base64(view);
            }
          },
          error: (error) => console.warn(error),
        });
        encoder.configure(config as VideoEncoderConfig);
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
        for (let index = 0; index < frames; index += 1) {
          context.fillStyle = `hsl(${(index * 7) % 360} 60% 40%)`;
          context.fillRect(0, 0, width, height);
          context.fillStyle = "#ffffff";
          const side = height / 4;
          context.fillRect(((index * width) / frames) % width, height / 2 - side / 2, side, side);
          const frame = new VideoFrame(canvas, { timestamp: Math.round((index * 1e6) / fps) });
          encoder.encode(frame, { keyFrame: index % fps === 0 });
          frame.close();
          if (encoder.encodeQueueSize > 8) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await encoder.flush();
        encoder.close();
        return { codec: candidate.codec, mime, config: description ? { description } : {}, chunks };
      }
      return undefined;
    },
    { width: size[0], height: size[1], frames: count, fps: FPS },
  );
}

/** The encoded frames in a file the compositor can read. */
async function fileOf(
  encoded: Encoded,
  width: number,
  height: number,
): Promise<{ readonly bytes: Buffer; readonly type: string }> {
  const webm = encoded.mime === "vp9";
  const output = new Output({
    format: webm ? new WebMOutputFormat() : new Mp4OutputFormat(),
    target: new BufferTarget(),
  });
  const source = new EncodedVideoPacketSource(webm ? "vp9" : "avc");
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();
  const description = encoded.config.description
    ? Buffer.from(encoded.config.description, "base64")
    : undefined;
  for (const [index, { data, key }] of encoded.chunks.entries()) {
    const packet = new EncodedPacket(
      Buffer.from(data, "base64"),
      key ? "key" : "delta",
      index / FPS,
      1 / FPS,
    );
    await source.add(
      packet,
      index === 0
        ? {
            decoderConfig: {
              codec: encoded.codec,
              codedWidth: width,
              codedHeight: height,
              ...(description && { description }),
            },
          }
        : undefined,
    );
  }
  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error("No file");
  return { bytes: Buffer.from(buffer), type: webm ? "video/webm" : "video/mp4" };
}

const video = (id: string, start: number, end: number, offset: number): RenderLayer => ({
  id,
  start,
  end,
  offset,
  source: { kind: "video", file: "moving" },
  fit: "contain",
  channels: {},
});

function planOf(
  [width, height]: readonly [number, number],
  layers: readonly RenderLayer[],
  joins: readonly RenderJoin[],
): RenderPlan {
  return {
    width,
    height,
    stage: { width: 1920, height: 1080 },
    camera: {},
    scenes: { format: "f", language: "zh-CN", fps: { num: FPS, den: 1 } },
    background: "#000000",
    layers: [...layers],
    joins: [...joins],
  };
}

interface Timing {
  readonly seconds: number;
  readonly ms: number;
  readonly decodeMs: number;
}

/** Sends the compositor something, as the editor does. */
const tell = (page: Page, message: unknown) =>
  content(page, "preview")
    .locator("iframe")
    .evaluate(
      (element: HTMLIFrameElement, sent) => element.contentWindow?.postMessage(sent, "*"),
      message,
    );

/**
 * Plays a plan from its start for a while, as the editor tells the compositor when it plays, and
 * gives what the compositor said about the frames it drew.
 */
async function play(page: Page, plan: RenderPlan): Promise<readonly Timing[]> {
  await tell(page, { type: "plan", plan });
  await tell(page, { type: "seek", seconds: 0, jump: true });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const own = window as unknown as { timings: Timing[] };
    own.timings = [];
  });
  await tell(page, { type: "record", on: true });
  await content(page, "preview")
    .locator("iframe")
    .evaluate(
      async (element: HTMLIFrameElement, { seconds, fps }) => {
        const start = performance.now();
        for (let frame = 1; frame < seconds * fps; frame += 1) {
          const wait = start + (frame * 1000) / fps - performance.now();
          if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
          element.contentWindow?.postMessage(
            { type: "seek", seconds: frame / fps, jump: false },
            "*",
          );
        }
      },
      { seconds: SECONDS, fps: FPS },
    );
  await page.waitForTimeout(1200);
  await tell(page, { type: "record", on: false });
  return page.evaluate(() => (window as unknown as { timings: Timing[] }).timings);
}

const median = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};
const p95 = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)] ?? Number.NaN;
};

function summary(timings: readonly Timing[], from: number, to: number) {
  const within = timings.filter(({ seconds }) => seconds >= from && seconds < to);
  return {
    drawn: within.length,
    perSecond: within.length / (to - from),
    ms: { median: median(within.map(({ ms }) => ms)), p95: p95(within.map(({ ms }) => ms)) },
    decodeMs: median(within.map(({ decodeMs }) => decodeMs)),
    drawMs: median(within.map(({ ms, decodeMs }) => ms - decodeMs)),
  };
}

for (const [name, size] of Object.entries(SIZES)) {
  test(`a dissolve between two videos at ${name}, against one video`, async ({ page }) => {
    test.skip(name === "4K" && !process.env["AQ_PERF_4K"], "4K only when asked for: AQ_PERF_4K=1");
    await page.evaluate(() => {
      const own = window as unknown as { timings: Timing[] };
      own.timings = [];
      addEventListener("message", (event) => {
        const data = event.data as { type?: string; frames?: Timing[] } | undefined;
        if (data?.type === "frames" && data.frames) own.timings.push(...data.frames);
      });
    });
    const [width, height] = size;
    const encoded = await encode(page, size, (SECONDS + 2) * FPS);
    test.skip(encoded === undefined, "this browser encodes neither H.264 nor VP9");
    if (!encoded) return;
    const { bytes, type } = await fileOf(encoded, width, height);
    await expect.poll(async () => (await findCompositor(page)) !== undefined).toBe(true);
    await content(page, "preview")
      .locator("iframe")
      .evaluate(
        (element: HTMLIFrameElement, { data, mime }) => {
          const file = new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], {
            type: mime,
          });
          element.contentWindow?.postMessage({ type: "file", id: "moving", file }, "*");
        },
        { data: bytes.toString("base64"), mime: type },
      );
    // One video all the way, then two halves of it with a dissolve of two seconds around the cut,
    // where both decode: the second from a second into the file, so that it has frames before.
    const one = planOf(size, [video("v", 0, SECONDS, 0)], []);
    const cut = SECONDS / 2;
    const joined = planOf(
      size,
      [
        { ...video("a", 0, cut, 0), shows: { from: 0, to: cut + 1 } },
        { ...video("b", cut, SECONDS, 1), shows: { from: cut - 1, to: SECONDS } },
      ],
      [
        {
          id: "j",
          track: "t",
          from: "a",
          to: "b",
          how: { kind: "built-in", type: "fade" },
          start: cut - 1,
          end: cut + 1,
          duration: 2,
        },
      ],
    );
    // Two videos on top of each other, the one above half see-through: what decoding and drawing
    // two of them takes without a join.
    const half = { opacity: { kind: "still", value: 0.5 } } as const;
    const stacked = planOf(
      size,
      [video("v", 0, SECONDS, 0), { ...video("w", 0, SECONDS, 1), channels: half }],
      [],
    );
    const alone = summary(await play(page, one), cut - 1, cut + 1);
    const both = summary(await play(page, stacked), cut - 1, cut + 1);
    const across = summary(await play(page, joined), cut - 1, cut + 1);
    console.log(
      [
        `${name} ${encoded.mime}`,
        `one video ${JSON.stringify(alone)}`,
        `two stacked ${JSON.stringify(both)}`,
        `two with a dissolve ${JSON.stringify(across)}`,
      ].join("\n"),
    );
    expect(alone.drawn).toBeGreaterThan(0);
    expect(both.drawn).toBeGreaterThan(0);
    expect(across.drawn).toBeGreaterThan(0);
  });
}
