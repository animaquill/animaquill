/**
 * What the browser tests of proxies share: videos encoded in the page as a camera would, project
 * folders on the disk with one of them on the timeline, and how the proxies of a project are.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject, type NewProject } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { drop, footer } from "./folder-support.ts";
import { expect, tab } from "./support.ts";

/** How many bars a frame has, which say which frame it is: up to 255. */
export const BITS = 8;

/** How a project writes down the hash of a file. */
export const hashOf = (bytes: Buffer) =>
  `sha256-${createHash("sha256")
    .update(bytes)
    .digest("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;

export interface VideoShape {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
}

export interface Encoding {
  /** H.264 at a level that holds the video. */
  readonly codec?: string;
  readonly bitrate?: number;
  /**
   * What the frames show: "bars" say which frame each is, in black and white; "detail" is what
   * moves in a scene, which takes about as long to decode as what a camera records; a colour is
   * all of it.
   */
  readonly look?: "bars" | "detail" | { readonly colour: string };
}

/** What the page encoded so far, which goes to the test a second at a time to keep memory small. */
interface EncodedPart {
  readonly chunks: readonly { readonly data: string; readonly key: boolean }[];
  readonly description?: string;
}

/**
 * A video encoded in the page, as a camera would: H.264, in MP4, a key frame every second. Nothing
 * of the editor makes it. A second at a time, so that a long 4K video does not fill the page.
 */
export async function encodeIn(
  page: Page,
  shape: VideoShape,
  count: number,
  { codec = "avc1.64001F", bitrate = 2_000_000, look = "bars" }: Encoding = {},
): Promise<Buffer> {
  const supported = await page.evaluate(
    async ({ width, height, fps, frames, bits, codecName, rate, kind, colour }) => {
      const base64 = (bytes: Uint8Array) => {
        let text = "";
        for (let at = 0; at < bytes.length; at += 0x8000) {
          text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
        }
        return btoa(text);
      };
      const config: VideoEncoderConfig = {
        codec: codecName,
        width,
        height,
        bitrate: rate,
        framerate: fps,
        avc: { format: "avc" },
      };
      if (!(await VideoEncoder.isConfigSupported(config)).supported) return false;
      const out: { chunks: { data: string; key: boolean }[]; description?: string } = {
        chunks: [],
      };
      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          out.chunks.push({ data: base64(data), key: chunk.type === "key" });
          const given = meta?.decoderConfig?.description;
          if (given && out.description === undefined) {
            out.description = base64(
              ArrayBuffer.isView(given)
                ? new Uint8Array(given.buffer, given.byteOffset, given.byteLength)
                : new Uint8Array(given),
            );
          }
        },
        error: (error) => console.warn(error),
      });
      encoder.configure(config);
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      // A tile of noise, for "detail".
      const tile = new OffscreenCanvas(256, 256);
      const noise = tile.getContext("2d") as OffscreenCanvasRenderingContext2D;
      const pixels = noise.createImageData(256, 256);
      for (let at = 0; at < pixels.data.length; at += 1) {
        pixels.data[at] = at % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
      }
      noise.putImageData(pixels, 0, 0);
      let next = 0;
      /** Encodes up to this frame, and gives what came out since the last time. */
      const encodeTo = async (end: number, last: boolean) => {
        for (; next < Math.min(end, frames); next += 1) {
          const index = next;
          if (kind === "colour") {
            context.fillStyle = colour;
            context.fillRect(0, 0, width, height);
          } else if (kind === "detail") {
            // Soft blobs that move, with finer ones over them: the detail of a scene. Noise as it
            // is takes all the bits an encoder can give, whatever bitrate it was told.
            const shift = (index * 7) % 1024;
            for (let y = -1024; y < height; y += 1024) {
              for (let x = -1024; x < width; x += 1024) {
                context.drawImage(tile, x + shift, y + shift / 2, 1024, 1024);
              }
            }
            context.globalAlpha = 0.2;
            for (let y = 0; y < height; y += 256) {
              for (let x = -256; x < width; x += 256) context.drawImage(tile, x + (shift % 256), y);
            }
            context.globalAlpha = 1;
          } else {
            for (let bit = 0; bit < bits; bit += 1) {
              context.fillStyle = (index >> bit) & 1 ? "#ffffff" : "#000000";
              context.fillRect((bit * width) / bits, 0, width / bits, height);
            }
          }
          const frame = new VideoFrame(canvas, {
            timestamp: Math.round((index * 1e6) / fps),
            duration: Math.round(1e6 / fps),
          });
          encoder.encode(frame, { keyFrame: index % fps === 0 });
          frame.close();
          while (encoder.encodeQueueSize > 8) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        if (last) {
          await encoder.flush();
          encoder.close();
        }
        const part = {
          chunks: out.chunks,
          ...(out.description && { description: out.description }),
        };
        out.chunks = [];
        return part;
      };
      Object.assign(window, { aqEncodeTo: encodeTo });
      return true;
    },
    {
      ...shape,
      frames: count,
      bits: BITS,
      codecName: codec,
      rate: bitrate,
      kind: typeof look === "string" ? look : "colour",
      colour: typeof look === "string" ? "" : look.colour,
    },
  );
  if (!supported) throw new Error("This browser cannot encode H.264");
  const chunks: EncodedPart["chunks"][number][] = [];
  let description: string | undefined;
  for (let end = shape.fps; ; end += shape.fps) {
    const last = end >= count;
    const part = await page.evaluate(
      ({ to, isLast }) =>
        (
          window as unknown as {
            aqEncodeTo: (end: number, last: boolean) => Promise<EncodedPart>;
          }
        ).aqEncodeTo(to, isLast),
      { to: end, isLast: last },
    );
    chunks.push(...part.chunks);
    description ??= part.description;
    if (last) break;
  }
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(source, { frameRate: shape.fps });
  await output.start();
  const head = description ? Buffer.from(description, "base64") : undefined;
  for (const [index, { data, key }] of chunks.entries()) {
    const packet = new EncodedPacket(
      Buffer.from(data, "base64"),
      key ? "key" : "delta",
      index / shape.fps,
      1 / shape.fps,
    );
    const decoderConfig = {
      codec,
      codedWidth: shape.width,
      codedHeight: shape.height,
      ...(head && { description: head }),
    };
    await source.add(packet, index === 0 ? { decoderConfig } : undefined);
  }
  await output.finalize();
  return Buffer.from((output.target as BufferTarget).buffer as ArrayBuffer);
}

/** A project folder on the disk with a video in it, on the timeline from the start. */
export function projectWith(
  video: Buffer,
  {
    seconds,
    format,
    shape,
  }: {
    readonly seconds: number;
    readonly format: NonNullable<NewProject["format"]>;
    readonly shape: VideoShape;
  },
): { disk: string; hash: string } {
  const hash = hashOf(video);
  const files = writeProject(createProject({ name: "代理项目", format }));
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({
    ...section,
    duration: String(seconds),
  }));
  (timeline.tracks[0] as { clips: unknown[] }).clips = [
    {
      id: "clip",
      start: "0",
      duration: String(seconds),
      source: { kind: "video", media: { asset: "video" } },
    },
  ];
  files.set(path, JSON.stringify(timeline));
  const asset = {
    name: "数字.mp4",
    kind: "video",
    path: "assets/数字.mp4",
    storage: "local",
    hash,
    size: video.length,
    info: {
      width: shape.width,
      height: shape.height,
      fps: String(shape.fps),
      duration: String(seconds),
    },
  };
  files.set("assets.json", JSON.stringify({ assets: { video: asset } }));
  const disk = join(mkdtempSync(join(tmpdir(), "animaquill-proxies-")), "代理项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(disk, name)), { recursive: true });
    writeFileSync(join(disk, name), text);
  }
  mkdirSync(join(disk, "assets"), { recursive: true });
  writeFileSync(join(disk, "assets/数字.mp4"), video);
  return { disk, hash };
}

/** Drops a project in, and waits until it is open and its folder has everything. */
export async function openProject(page: Page, disk: string) {
  await drop(page, disk);
  // Opening reads the whole folder and hashes the video: on a busy machine that takes a while.
  await expect(tab(page, "preview")).toBeVisible({ timeout: 15_000 });
  await expect(footer(page).getByText("已保存")).toBeVisible({ timeout: 10_000 });
}

/** How the proxy of a video is, from the hooks of the development page. */
export const stateIn = (page: Page, hash: string) =>
  page.evaluate((wanted) => {
    const { aqProxies } = window as unknown as {
      aqProxies: () => { states: Record<string, { kind: string; percent?: number }> } | undefined;
    };
    return aqProxies()?.states[wanted] ?? { kind: "none" };
  }, hash);

export const kindIn = async (page: Page, hash: string) => (await stateIn(page, hash)).kind;
