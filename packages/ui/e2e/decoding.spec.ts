/**
 * How much the preview decodes while it stands still on a video: once the frame is there, nothing
 * more, also when the picture gets drawn again, as a scene, a plan or a file has it drawn. A clip at
 * the start of a file that starts a little late, as phones record them, coming up next is what
 * used to start a decoder for each drawing.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject } from "@animaquill/schema";
import type { Frame, Page } from "@playwright/test";
import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { encodeIn, hashOf, openProject } from "./proxy-support.ts";
import { compositor, content, expect, test } from "./support.ts";

test.use({
  folders: true,
  withProject: false,
  launchOptions: {
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--site-per-process", "--enable-experimental-web-platform-features"],
  },
});
test.setTimeout(120_000);

const SHAPE = { width: 320, height: 180, fps: 30 };

/** The same video with every frame a little later, so that its first frame is not at its start. */
async function startingLate(video: Buffer, seconds: number): Promise<Buffer> {
  const input = new Input({ source: new BufferSource(video), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video");
  const decoderConfig = await track.getDecoderConfig();
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(source, { frameRate: SHAPE.fps });
  await output.start();
  let first = true;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    const later = new EncodedPacket(
      packet.data,
      packet.type,
      packet.timestamp + seconds,
      packet.duration,
    );
    await source.add(later, first && decoderConfig ? { decoderConfig } : undefined);
    first = false;
  }
  await output.finalize();
  input.dispose();
  return Buffer.from((output.target as BufferTarget).buffer as ArrayBuffer);
}

/** Two clips of one video: the middle of it, then its start, which comes up while on the first. */
function projectWith(video: Buffer): string {
  const files = writeProject(
    createProject({ name: "解码", format: { id: "small", name: "小屏", ...SHAPE, fps: "30" } }),
  );
  const path = "timelines/main/timeline.json";
  const timeline = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: { clips: unknown[] }[];
  };
  timeline.sections = timeline.sections.map((section) => ({ ...section, duration: "2" }));
  const source = { kind: "video", media: { asset: "video" } };
  (timeline.tracks[0] as { clips: unknown[] }).clips = [
    { id: "middle", start: "0", duration: "1", offset: "1", source },
    { id: "start", start: "1", duration: "1", offset: "0", source },
  ];
  files.set(path, JSON.stringify(timeline));
  const asset = {
    name: "手机.mp4",
    kind: "video",
    path: "assets/手机.mp4",
    storage: "local",
    hash: hashOf(video),
    size: video.length,
    info: { width: SHAPE.width, height: SHAPE.height, fps: "30", duration: "3" },
  };
  files.set("assets.json", JSON.stringify({ assets: { video: asset } }));
  const disk = join(mkdtempSync(join(tmpdir(), "animaquill-decoding-")), "解码");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(disk, name)), { recursive: true });
    writeFileSync(join(disk, name), text);
  }
  mkdirSync(join(disk, "assets"), { recursive: true });
  writeFileSync(join(disk, "assets/手机.mp4"), video);
  return disk;
}

/** Counts what the decoders of every frame do, from before any code of the frame runs. */
const countDecoding = (page: Page) =>
  page.addInitScript(() => {
    if (typeof VideoDecoder === "undefined") return;
    const counts = { decoders: 0, frames: 0 };
    Object.assign(window, { aqDecoding: counts });
    const Real = VideoDecoder;
    window.VideoDecoder = class extends Real {
      constructor(init: VideoDecoderInit) {
        counts.decoders += 1;
        super({
          ...init,
          output: (frame) => {
            counts.frames += 1;
            init.output(frame);
          },
        });
      }
    };
  });

const decodingIn = (frame: Frame) =>
  frame.evaluate(
    () => (window as unknown as { aqDecoding: { decoders: number; frames: number } }).aqDecoding,
  );

test("standing still on a video decodes nothing more, also when drawn again", async ({ page }) => {
  const video = await startingLate(await encodeIn(page, SHAPE, 90), 2 / SHAPE.fps);
  await countDecoding(page);
  await page.reload();
  await openProject(page, projectWith(video));
  const frame = await compositor(page);
  const picture = content(page, "preview").locator("iframe");
  // Half a second into the first clip, with the start of the video coming up next.
  const seconds = 0.5;
  await picture.evaluate((element: HTMLIFrameElement, wanted) => {
    element.contentWindow?.postMessage({ type: "seek", seconds: wanted, jump: true }, "*");
  }, seconds);
  // Until the frame is there and the next clip is ready: nothing gets decoded for a while.
  let last = await decodingIn(frame);
  await expect
    .poll(
      async () => {
        const now = await decodingIn(frame);
        const still = now.frames > 0 && now.frames === last.frames;
        last = now;
        return still;
      },
      { intervals: [1000] },
    )
    .toBe(true);
  const before = await decodingIn(frame);
  for (let time = 0; time < 10; time += 1) {
    await picture.evaluate((element: HTMLIFrameElement, wanted) => {
      element.contentWindow?.postMessage({ type: "seek", seconds: wanted, jump: false }, "*");
    }, seconds);
    await page.waitForTimeout(300);
  }
  const after = await decodingIn(frame);
  expect(after.decoders - before.decoders).toBe(0);
  expect(after.frames - before.frames).toBeLessThanOrEqual(2);
});
