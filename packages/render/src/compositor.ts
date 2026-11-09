// oxlint-disable-next-line typescript/triple-slash-reference -- packages that bundle this need it too
/// <reference path="./virtual.d.ts" />
import code from "virtual:animaquill-scene-runtime";
import soundCode from "virtual:animaquill-sound-runtime";
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from "mediabunny";
import type { RenderLayer, RenderPlan } from "@animaquill/core";
import {
  TIME_TOLERANCE,
  boxOf,
  fitIn,
  layerMatrix,
  multiply,
  transformPoint,
  viewMatrix,
  type Matrix,
} from "@animaquill/core/view";
import { Composer, type Context2D } from "./compose.ts";
import { comesUpAfter, fileTimeOf, readingAt, showsAt, VideoCursor } from "./cursor.ts";
import type { Corners } from "./transitions/code.ts";
import { GiveUpTimer } from "./patience.ts";
import { withChannels } from "./plan.ts";
import { placeholderPicture } from "./placeholder.ts";
import { SceneLayers } from "./scenes.ts";
import { SoundJobs } from "./sounds.ts";
import { failureOf, FileArrivals, stillPictures, StillFailed } from "./still.ts";
import type { FrameTiming, FrameToEncode, FromCompositor, ToCompositor } from "./index.ts";

/**
 * The compositor. It runs in a sandbox on a site of its own, where it can decode, draw and later
 * encode without network or storage. Everything it gets comes from the editor as a message.
 */

interface Picture {
  readonly width: number;
  readonly height: number;
  /** Draws a part of it, in its pixels, on the same pixels of whatever the matrix says. */
  draw(target: Context2D, x: number, y: number, width: number, height: number): void;
  close(): void;
}

/**
 * Errors of the compositor itself go to the editor, which asks people whether to report them. The
 * code of projects runs on pages of its own, so nothing of it is in here. A few say it all.
 */
const MAX_FAILURES = 20;
let failures = 0;
function sayFailed(error: unknown): void {
  if (failures >= MAX_FAILURES) return;
  failures += 1;
  const text = (value: unknown, limit: number) =>
    typeof value === "string" ? value.slice(0, limit) : undefined;
  const { name, message, stack } =
    error instanceof Error ? error : { name: undefined, message: String(error), stack: undefined };
  const failed: FromCompositor = {
    type: "failed",
    name: text(name, 100),
    message: text(message, 1000),
    stack: text(stack, 8000),
  };
  parent.postMessage(failed, "*");
}
addEventListener("error", (event) => sayFailed(event.error ?? event.message));
addEventListener("unhandledrejection", (event) => sayFailed(event.reason));

const TIMINGS_EVERY_MS = 500;
/** Often enough that the editor can count the last second without waiting for the next word. */
const PAINTED_EVERY_MS = 250;

interface VideoFile {
  readonly sink: VideoSampleSink;
  readonly input: Input;
}

/**
 * Decoded pictures and opened videos that are not needed at the moment stay around for this many
 * files, for going back and forth: a picture takes its pixels in memory, whatever size the file is.
 */
const KEEP_FILES = 6;

const canvas = document.createElement("canvas");
const context = canvas.getContext("2d", { alpha: false });
if (!context) throw new Error("No 2D context");
const draw = context;

Object.assign(document.documentElement.style, { height: "100%", background: "#000" });
Object.assign(document.body.style, {
  height: "100%",
  margin: "0",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
});
// As large as it would be at full quality, which is never more than there is room for. A picture
// with fewer pixels gets stretched into the same place.
Object.assign(canvas.style, {
  width: "100%",
  height: "100%",
  objectFit: "contain",
  display: "block",
});

/** How much room the picture takes, in pixels of the page, whatever it is drawn at. */
function sizeOnScreen({ width, height }: { readonly width: number; readonly height: number }) {
  Object.assign(canvas.style, { maxWidth: `${width}px`, maxHeight: `${height}px` });
}
document.body.append(canvas);

const send = (message: FromCompositor, transfer: Transferable[] = []) =>
  parent.postMessage(message, "*", transfer);

let plan: RenderPlan | undefined;
/** The plan without what somebody is only trying out. A scene does not start over for that. */
let settledPlan: RenderPlan | undefined;
const files = new Map<string, Blob>();
const arrivals = new FileArrivals();
const images = new Map<string, Promise<ImageBitmap | undefined>>();
const videos = new Map<string, Promise<VideoFile | undefined>>();
const asked = new Set<string>();
/** By layer, because two clips of one file read different places. */
const cursors = new Map<
  string,
  { readonly file: string; readonly cursor: VideoCursor<VideoSample> }
>();

let wanted = 0;
/** This one only draws what `still` asks for. */
let exporting = false;
/** One at a time: they draw on the same canvas and read the same videos. */
let stills: Promise<void> = Promise.resolve();
let gettingReady = false;
let recording = false;
let coldInFrame = 0;
let decodeMsInFrame = 0;
let timings: FrameTiming[] = [];
let drawing = false;
let drawAgain = false;
/** How many times somebody moved the playhead, and how many of those the frame being drawn knows. */
let jumps = 0;
let jumpsInFrame = 0;
/** The frame being drawn stays unfinished, and nothing of it reaches the screen. */
let frameGivenUp = false;
/** Frames given up since the last one that was drawn. */
let abandoned = 0;
/** When frames of a new place on the timeline reached the canvas, since the editor last heard. */
let paintedAt: number[] = [];
/** The place the last of them showed. Drawing a place again is not another frame of it. */
let lastPainted: number | undefined;

function fileOf(id: string): Blob | undefined {
  const file = files.get(id);
  if (!file && !asked.has(id)) {
    asked.add(id);
    send({ type: "needs", id });
  }
  return file;
}

function imageOf(id: string, file: Blob): Promise<ImageBitmap | undefined> {
  let image = images.get(id);
  if (!image) {
    image = createImageBitmap(file).catch(() => {
      send({ type: "cannot-decode", id });
      return undefined;
    });
    images.set(id, image);
  }
  return image;
}

async function openVideo(id: string, file: Blob): Promise<VideoFile | undefined> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (track && (await track.canDecode())) return { sink: new VideoSampleSink(track), input };
  input.dispose();
  send({ type: "cannot-decode", id });
  return undefined;
}

function videoOf(id: string, file: Blob): Promise<VideoFile | undefined> {
  let video = videos.get(id);
  if (!video) {
    video = openVideo(id, file).catch(() => {
      send({ type: "cannot-decode", id });
      return undefined;
    });
    videos.set(id, video);
  }
  return video;
}

async function cursorOf(
  layer: RenderLayer,
  id: string,
  file: Blob,
): Promise<VideoCursor<VideoSample> | undefined> {
  const video = await videoOf(id, file);
  if (!video) return undefined;
  let entry = cursors.get(layer.id);
  if (entry?.file !== id) {
    await entry?.cursor.close();
    entry = { file: id, cursor: new VideoCursor(video.sink) };
    cursors.set(layer.id, entry);
  }
  return entry.cursor;
}

const imagePicture = (bitmap: ImageBitmap | OffscreenCanvas, close = () => {}): Picture => ({
  width: bitmap.width,
  height: bitmap.height,
  draw(target, x, y, width, height) {
    target.drawImage(bitmap, x, y, width, height, x, y, width, height);
  },
  close,
});

/**
 * What a phone records upright is stored on its side with a note to turn it, and only the sample
 * knows how to read parts of that. Going around it for all the other videos keeps the numbers that
 * reach the canvas the same as for a picture.
 */
const videoPicture = (sample: VideoSample): Picture => ({
  width: sample.displayWidth,
  height: sample.displayHeight,
  draw(target, x, y, width, height) {
    if (sample.rotation !== 0 || sample.flip) {
      sample.draw(target, x, y, width, height, x, y, width, height);
    } else {
      target.drawImage(sample.toCanvasImageSource(), x, y, width, height, x, y, width, height);
    }
  },
  close() {},
});

/** Whatever a scene has last. It runs at its own pace, and frames in between just do not show. */
function scenePictureOf({ id }: RenderLayer): Picture | undefined {
  const held = scenes.pictureOf(id);
  if (held) return imagePicture(held.image, held.release);
  return scenes.showsPlaceholder(id) ? imagePicture(placeholderPicture()) : undefined;
}

async function pictureOf(layer: RenderLayer, seconds: number): Promise<Picture | undefined> {
  const { source } = layer;
  if (source.kind === "color") return undefined;
  if (source.kind === "scene") return scenePictureOf(layer);
  const file = fileOf(source.file);
  if (!file) return undefined;
  if (source.kind === "image") {
    const bitmap = await imageOf(source.file, file);
    return bitmap && imagePicture(bitmap);
  }
  const cursor = await cursorOf(layer, source.file, file);
  // Opening the file takes a while, and the playhead does not wait for it.
  if (jumps !== jumpsInFrame) {
    frameGivenUp = true;
    return undefined;
  }
  const sample = await cursor?.at(fileTimeOf(layer, seconds));
  if (cursor?.takeCold()) coldInFrame += 1;
  return sample && videoPicture(sample);
}

/** Clips that start soon. */
const upcomingAt = (seconds: number): readonly RenderLayer[] =>
  plan?.layers.filter((layer) => comesUpAfter(layer, seconds)) ?? [];

/**
 * Opening a file and decoding up to a first frame takes longer than a frame may, so a clip does that
 * before it shows, and playing goes straight from one clip into the next.
 */
async function getReady(seconds: number): Promise<void> {
  for (const layer of upcomingAt(seconds)) {
    const { source } = layer;
    if (source.kind === "color" || source.kind === "scene") continue;
    const file = fileOf(source.file);
    if (!file) continue;
    if (source.kind === "image") {
      await imageOf(source.file, file);
      continue;
    }
    const cursor = await cursorOf(layer, source.file, file);
    const reading = readingAt(layer, seconds);
    if (reading !== undefined) await cursor?.at(reading);
    cursor?.takeCold();
  }
}

/** When each file was last needed, for letting go of the ones that have not been for longest. */
const lastNeeded = new Map<string, number>();
let needs = 0;

/** Lets go of pictures and videos no clip around this moment uses, but for the latest few. */
function releaseFilesExcept(keep: readonly RenderLayer[]): void {
  needs += 1;
  for (const { source } of keep) {
    if (source.kind === "image" || source.kind === "video") lastNeeded.set(source.file, needs);
  }
  // A cursor may still read a file while a frame that went before it gets drawn.
  const reading = new Set([...cursors.values()].map(({ file }) => file));
  const stale = [...lastNeeded]
    .filter(([id, at]) => at !== needs && !reading.has(id))
    .toSorted(([, a], [, b]) => b - a)
    .slice(KEEP_FILES);
  for (const [id] of stale) {
    lastNeeded.delete(id);
    void images.get(id)?.then((bitmap) => bitmap?.close());
    images.delete(id);
    void videos.get(id)?.then((video) => video?.input.dispose());
    videos.delete(id);
  }
  // For seeing how much is held, also from a test.
  document.documentElement.dataset["pictures"] = String(images.size);
  document.documentElement.dataset["videos"] = String(videos.size);
}

/** Whether two files are one file of a disk as it was, which reads the same either way. */
const isSameFile = (a: Blob, b: Blob): boolean =>
  a === b ||
  (a instanceof File &&
    b instanceof File &&
    a.name === b.name &&
    a.size === b.size &&
    a.lastModified === b.lastModified);

/**
 * Lets go of what was read of a file, which the picture then reads again from what is there now. A
 * frame that was being drawn from it may not get there, so the picture is drawn again after.
 */
async function forgetRead(id: string): Promise<void> {
  const image = images.get(id);
  images.delete(id);
  const video = videos.get(id);
  videos.delete(id);
  const reading = [...cursors].filter(([, entry]) => entry.file === id);
  for (const [layer] of reading) cursors.delete(layer);
  try {
    await Promise.all(reading.map(([, { cursor }]) => cursor.close().catch(() => {})));
    await image?.then((bitmap) => bitmap?.close());
    await video?.then((opened) => opened?.input.dispose());
  } finally {
    void refresh();
  }
}

/** A decoder is a scarce thing, so a clip that left the picture gives its own back. */
async function closeCursorsExcept(keep: readonly RenderLayer[]): Promise<void> {
  const ids = new Set(keep.map(({ id }) => id));
  for (const [id, { cursor }] of cursors) {
    if (ids.has(id)) continue;
    cursors.delete(id);
    await cursor.close();
  }
}

/** Reading to a place the playhead left is what keeps it from getting to where it is now. */
function giveUpFor(seconds: number): boolean {
  let gaveUp = false;
  for (const [id, { cursor }] of cursors) {
    const layer = plan?.layers.find((candidate) => candidate.id === id);
    if (cursor.giveUpUnlessLeadsTo(layer && readingAt(layer, seconds))) gaveUp = true;
  }
  if (gaveUp) {
    frameGivenUp = true;
    void refresh();
  }
  return gaveUp;
}

/** Only somebody moving the playhead starts this. Time carries it along without any rest. */
const patience = new GiveUpTimer(
  (milliseconds, run) => {
    const timer = setTimeout(run, milliseconds);
    return () => clearTimeout(timer);
  },
  () => giveUpFor(wanted),
);

/** Canvas ignores a matrix it cannot use and would draw with the one before. */
const canUse = (matrix: Matrix) => matrix.every((number) => Number.isFinite(number));

/** Where a clip box is on the picture, by its corners in pixels. */
function cornersOf(toPicture: Matrix, box: { width: number; height: number }): Corners {
  const at = (x: number, y: number) => transformPoint(toPicture, { x, y });
  return [at(0, 0), at(box.width, 0), at(box.width, box.height), at(0, box.height)];
}

/**
 * Colors and pictures are one kind of thing here: a box in the world, with something in it. Says
 * where the box ended up on the picture, for transitions that want to know.
 */
function paint(
  target: Context2D,
  layer: RenderLayer,
  picture: Picture | undefined,
  view: Matrix,
  seconds: number,
  stage: RenderPlan["stage"],
  opacity: number,
  operation: GlobalCompositeOperation = "source-over",
): Corners | undefined {
  const { source } = layer;
  if (opacity <= 0 || (source.kind !== "color" && !picture)) return undefined;
  // A scene is laid out for its box, so its picture says nothing about what that box is.
  const box = boxOf(layer, seconds, source.kind === "scene" ? undefined : picture, stage);
  if (box.width <= 0 || box.height <= 0) return undefined;
  const toPicture = multiply(view, layerMatrix(layer, seconds, box));
  target.globalCompositeOperation = operation;
  target.globalAlpha = Math.min(opacity, 1);
  if (picture) {
    const { source: part, matrix } = fitIn(layer.fit, picture, box);
    const fromMedia = multiply(toPicture, matrix);
    if (!canUse(fromMedia)) return undefined;
    target.setTransform(...fromMedia);
    picture.draw(target, part.x, part.y, part.width, part.height);
  } else if (source.kind === "color" && canUse(toPicture)) {
    target.setTransform(...toPicture);
    target.fillStyle = source.color;
    target.fillRect(0, 0, box.width, box.height);
  }
  target.globalAlpha = 1;
  target.globalCompositeOperation = "source-over";
  return canUse(toPicture) ? cornersOf(toPicture, box) : undefined;
}

/** Draws transitions, which takes pictures of their own for the layers they are about. */
const composer = new Composer();

/** A transition at this moment that this editor cannot do, which a picture that goes out must not have. */
function missingJoinAt(shown: RenderPlan, seconds: number): string | undefined {
  const join = shown.joins.find(
    ({ missing, start, end }) =>
      missing === true && seconds >= start - TIME_TOLERANCE && seconds < end - TIME_TOLERANCE,
  );
  return join?.from;
}

/** Everything is decoded first, so that a frame appears whole and never half drawn. */
async function drawFrame(seconds: number): Promise<boolean> {
  const shown = plan;
  if (!shown) return false;
  const showing = shown.layers.filter((layer) => showsAt(layer, seconds));
  await closeCursorsExcept([...showing, ...upcomingAt(seconds)]);
  releaseFilesExcept([...showing, ...upcomingAt(seconds)]);
  const askedAt = performance.now();
  // A picture of a scene is held until it is drawn, so one that fails must not keep the others.
  const results = await Promise.allSettled(showing.map((layer) => pictureOf(layer, seconds)));
  const pictures = results.map((result) =>
    result.status === "fulfilled" ? result.value : undefined,
  );
  decodeMsInFrame = performance.now() - askedAt;
  try {
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    if (frameGivenUp) return false;
    paintAll(shown, showing, pictures, seconds);
    return true;
  } finally {
    for (const picture of pictures) picture?.close();
  }
}

function paintAll(
  shown: RenderPlan,
  showing: readonly RenderLayer[],
  pictures: readonly (Picture | undefined)[],
  seconds: number,
): void {
  if (canvas.width !== shown.width) canvas.width = shown.width;
  if (canvas.height !== shown.height) canvas.height = shown.height;
  draw.resetTransform();
  draw.globalAlpha = 1;
  draw.globalCompositeOperation = "source-over";
  draw.fillStyle = shown.background;
  draw.fillRect(0, 0, canvas.width, canvas.height);
  const view = viewMatrix(shown, seconds);
  const pictureOfLayer = new Map(showing.map((layer, index) => [layer, pictures[index]]));
  composer.compose(draw, shown, showing, seconds, (target, layer, opacity, operation) =>
    paint(target, layer, pictureOfLayer.get(layer), view, seconds, shown.stage, opacity, operation),
  );
}

/** One frame at a time. When time runs ahead of it, frames in between are skipped. */
async function refresh(): Promise<void> {
  if (exporting) return;
  if (drawing) {
    drawAgain = true;
    return;
  }
  drawing = true;
  do {
    drawAgain = false;
    frameGivenUp = false;
    jumpsInFrame = jumps;
    const seconds = wanted;
    const started = performance.now();
    coldInFrame = 0;
    decodeMsInFrame = 0;
    const wasGettingReady = gettingReady;
    try {
      if ((await drawFrame(seconds)) && seconds !== lastPainted) {
        lastPainted = seconds;
        paintedAt.push(performance.now());
      }
    } catch (error) {
      console.warn("A frame could not be drawn", error);
    }
    if (frameGivenUp) {
      // Whatever did this asked for the next round.
      if (recording) abandoned += 1;
      continue;
    }
    patience.drew();
    // Getting ready for a place the playhead left would only be in the way.
    if (!gettingReady && jumps === jumpsInFrame) {
      gettingReady = true;
      void getReady(seconds)
        .catch((error: unknown) => console.warn("A clip could not get ready", error))
        .finally(() => {
          gettingReady = false;
        });
    }
    if (recording) {
      const ms = performance.now() - started;
      const behindMs = Math.max(wanted - seconds, 0) * 1000;
      timings.push({
        seconds,
        ms,
        decodeMs: decodeMsInFrame,
        gettingReady: wasGettingReady,
        cold: coldInFrame,
        behindMs,
        abandoned,
      });
      abandoned = 0;
    }
  } while (drawAgain);
  drawing = false;
}

/** The same painting as the preview, after waiting for everything that the preview goes without. */
async function paintStill(seconds: number): Promise<void> {
  const shown = plan;
  if (!shown) throw new StillFailed({ reason: "failed", message: "No plan" });
  wanted = seconds;
  scenes.follow(settledPlan, seconds, shown);
  const showing = shown.layers.filter((layer) => showsAt(layer, seconds));
  await closeCursorsExcept(showing);
  releaseFilesExcept(showing);
  const missing = missingJoinAt(shown, seconds);
  if (missing !== undefined) throw new StillFailed({ reason: "transition", layer: missing });
  const pictures = await stillPictures<Picture>(showing, seconds, {
    file(id) {
      const file = fileOf(id);
      return file ? Promise.resolve(file) : arrivals.wait(id);
    },
    image: async (_, id, file) => {
      const bitmap = await imageOf(id, file);
      return bitmap && imagePicture(bitmap);
    },
    video: async (layer, id, file) => {
      const cursor = await cursorOf(layer, id, file);
      const sample = await cursor?.at(fileTimeOf(layer, seconds));
      return sample && videoPicture(sample);
    },
    scene: async ({ id }) => {
      const held = await scenes.exactPicture(id);
      return imagePicture(held.image, held.release);
    },
  });
  try {
    paintAll(shown, showing, pictures, seconds);
  } finally {
    for (const picture of pictures) picture?.close();
  }
}

async function makeStill(seconds: number): Promise<ImageBitmap> {
  await paintStill(seconds);
  return createImageBitmap(canvas);
}

async function answerStill(request: number, seconds: number): Promise<void> {
  try {
    const image = await makeStill(seconds);
    send({ type: "still", request, image }, [image]);
  } catch (error) {
    console.warn("No still", error);
    send({ type: "still", request, failure: failureOf(error) });
  }
}

const notExporting = () => {
  throw new StillFailed({ reason: "failed", message: "Not a compositor for exports" });
};

/** Frames waiting in the encoder. More only take memory, and the encoder works through them anyway. */
const ENCODER_QUEUE = 4;

interface Encoding {
  readonly encoder: VideoEncoder;
  /** What the encoder said went wrong. It says so once, and nothing after that works. */
  failed: unknown;
}

let encoding: Encoding | undefined;

/** Bytes of their own, whatever they were part of. */
function copyOf(bytes: AllowSharedBufferSource): ArrayBuffer {
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  return view.slice().buffer;
}

/** What the encoder says about decoding, as it can cross: it may come as objects of this page. */
function decoderConfigOf(
  meta: EncodedVideoChunkMetadata | undefined,
): VideoDecoderConfig | undefined {
  const config = meta?.decoderConfig;
  if (!config) return undefined;
  const { description, colorSpace } = config;
  const copied = description && copyOf(description);
  const space =
    colorSpace && ("toJSON" in colorSpace ? (colorSpace as VideoColorSpace).toJSON() : colorSpace);
  return {
    codec: config.codec,
    ...(config.codedWidth !== undefined && { codedWidth: config.codedWidth }),
    ...(config.codedHeight !== undefined && { codedHeight: config.codedHeight }),
    ...(copied && { description: copied }),
    ...(space && { colorSpace: space }),
  };
}

function startEncoding(config: VideoEncoderConfig): void {
  // One that failed closed itself already.
  if (encoding?.encoder.state !== "closed") encoding?.encoder.close();
  const current: Encoding = {
    failed: undefined,
    encoder: new VideoEncoder({
      output(chunk, meta) {
        const data = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(data);
        const decoderConfig = decoderConfigOf(meta);
        const encoded = {
          type: "encoded" as const,
          data,
          key: chunk.type === "key",
          timestamp: chunk.timestamp,
          duration: chunk.duration ?? 0,
          ...(decoderConfig && { decoderConfig }),
        };
        send(encoded, [data]);
      },
      error(error) {
        current.failed ??= encoderFailed(error);
      },
    }),
  };
  encoding = current;
  try {
    current.encoder.configure(config);
  } catch (error) {
    throw encoderFailed(error);
  }
}

/** What the encoder says when it fails, as a failure of the encoder and not of the picture. */
const encoderFailed = (error: unknown) =>
  error instanceof StillFailed
    ? error
    : new StillFailed({
        reason: "encoder",
        message: error instanceof Error ? error.message : String(error),
      });

const encoderOf = (): Encoding => {
  if (!encoding) throw new StillFailed({ reason: "failed", message: "No encoder" });
  if (encoding.failed !== undefined) throw encoding.failed;
  return encoding;
};

/** Until the encoder has room. It says so with an event, which it may not send while it fails. */
async function roomInEncoder(current: Encoding): Promise<void> {
  const { encoder } = current;
  while (encoder.encodeQueueSize > ENCODER_QUEUE && current.failed === undefined) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      encoder.addEventListener(
        "dequeue",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  if (current.failed !== undefined) throw current.failed;
}

async function encodeFrame({ seconds, timestamp, duration, keyFrame }: FrameToEncode) {
  const current = encoderOf();
  await paintStill(seconds);
  const frame = new VideoFrame(canvas, { timestamp, duration });
  try {
    current.encoder.encode(frame, { keyFrame });
  } catch (error) {
    throw current.failed ?? encoderFailed(error);
  } finally {
    frame.close();
  }
  await roomInEncoder(current);
}

async function flushEncoding(): Promise<void> {
  const current = encoderOf();
  await current.encoder.flush().catch((error: unknown) => {
    throw current.failed ?? encoderFailed(error);
  });
  if (current.failed !== undefined) throw current.failed;
}

async function finishEncoding(): Promise<void> {
  const current = encoderOf();
  encoding = undefined;
  // Everything it has comes out before this is over, so the answer comes after all of it.
  await current.encoder.flush().catch((error: unknown) => {
    throw current.failed ?? encoderFailed(error);
  });
  current.encoder.close();
  if (current.failed !== undefined) throw current.failed;
}

async function answerEncoding(request: number, work: () => Promise<void> | void): Promise<void> {
  try {
    await work();
    send({ type: "encode-answer", request });
  } catch (error) {
    console.warn("Not encoded", error);
    send({ type: "encode-answer", request, failure: failureOf(error) });
  }
}

async function makeStrip(file: Blob, count: number, height: number) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return undefined;
    const duration = await track.computeDuration();
    const width = Math.max(Math.round((height * track.displayWidth) / track.displayHeight), 1);
    const strip = new OffscreenCanvas(width * count, height);
    const painter = strip.getContext("2d");
    const moments = Array.from({ length: count }, (_, slot) => (duration * (slot + 0.5)) / count);
    let slot = 0;
    for await (const sample of new VideoSampleSink(track).samplesAtTimestamps(moments)) {
      if (sample) {
        painter?.drawImage(sample.toCanvasImageSource(), slot * width, 0, width, height);
        sample.close();
      }
      slot += 1;
    }
    return strip.transferToImageBitmap();
  } finally {
    input.dispose();
  }
}

async function answerStrip(request: number, file: Blob, count: number, height: number) {
  const image = await makeStrip(file, count, height).catch((error: unknown) => {
    console.warn("No frames for this video", error);
    return undefined;
  });
  send({ type: "strip", request, image }, image ? [image] : []);
}

let sceneRuntime: Blob | undefined;

const scenes = new SceneLayers({
  mount: document.body,
  runtime: () => (sceneRuntime ??= new Blob([code], { type: "text/javascript" })),
  send,
  redraw: () => void refresh(),
});

let soundRuntime: Blob | undefined;

const sounds = new SoundJobs({
  mount: document.body,
  runtime: () => (soundRuntime ??= new Blob([soundCode], { type: "text/javascript" })),
  send,
});

addEventListener("message", (event: MessageEvent<ToCompositor>) => {
  // A scene can write here too, and only reading `data` builds a message: that comes after this.
  if (event.source !== parent) return;
  handle(event.data);
});

/**
 * The line from whoever hears `ready`, which is the page this is in. A window of its own is not
 * the page that writes to it: what the editor writes there comes from the editor, which this page
 * cannot tell from a stranger. What comes through this port can only come from whoever got it.
 */
const line = new MessageChannel();
line.port1.addEventListener("message", (event: MessageEvent<ToCompositor>) => handle(event.data));
line.port1.start();

function handle(data: ToCompositor): void {
  if (data.type === "ping") {
    send({ type: "pong", nonce: data.nonce });
    return;
  }
  if (data.type === "focus-taken") {
    scenes.focusTaken();
    send({ type: "focus-checked", request: data.request });
    return;
  }
  if (sounds.handle(data)) return;
  if (scenes.handle(data)) return;
  if (data.type === "strip") {
    void answerStrip(data.request, data.file, data.count, data.height);
    return;
  }
  if (data.type === "record") {
    recording = data.on;
    return;
  }
  if (data.type === "exporting") {
    exporting = true;
    return;
  }
  if (data.type === "still") {
    stills = stills.then(() => answerStill(data.request, data.seconds));
    return;
  }
  if (
    data.type === "encode-start" ||
    data.type === "encode-frame" ||
    data.type === "encode-flush" ||
    data.type === "encode-end"
  ) {
    const { request } = data;
    const work =
      data.type === "encode-start"
        ? () => startEncoding(data.config)
        : data.type === "encode-frame"
          ? () => encodeFrame(data)
          : data.type === "encode-flush"
            ? flushEncoding
            : finishEncoding;
    stills = stills.then(() => answerEncoding(request, exporting ? work : notExporting));
    return;
  }
  if (data.type === "no-file") {
    // Somebody may bring it back, so that the next one gets to ask again.
    asked.delete(data.id);
    // It went away after it came, as a file of a project folder can: what was read of it goes too.
    if (files.delete(data.id)) void forgetRead(data.id);
    arrivals.settle(data.id, undefined);
    return;
  }
  if (data.type === "plan") {
    plan = data.plan;
    sizeOnScreen(data.full ?? data.plan);
    settledPlan = data.settled ?? data.plan;
  } else if (data.type === "channels") {
    if (plan) plan = withChannels(plan, data.layer, data);
  } else if (data.type === "seek") {
    wanted = data.seconds;
    if (data.jump) {
      jumps += 1;
      patience.jumped();
    }
  } else {
    const before = files.get(data.id);
    // The same content in another file, as after the file changed on the disk: the old one cannot
    // be read any more. The same file of a disk again, as when it is sent twice, is nothing new.
    if (before && !isSameFile(before, data.file)) {
      files.set(data.id, data.file);
      void forgetRead(data.id);
    } else if (!before) {
      files.set(data.id, data.file);
    }
    arrivals.settle(data.id, data.file);
  }
  // It goes where `still` says, and a scene at the start of the plan is not worth opening for nothing.
  if (exporting) return;
  try {
    scenes.follow(settledPlan, wanted, plan);
  } finally {
    // Whatever went wrong with a scene, the rest of the picture goes on.
    void refresh();
  }
}

setInterval(() => {
  if (timings.length === 0) return;
  send({ type: "frames", frames: timings });
  timings = [];
}, TIMINGS_EVERY_MS);

setInterval(() => {
  if (paintedAt.length === 0) return;
  // Each side has a clock of its own, so this says how long ago, and the editor counts back from when it heard.
  const now = performance.now();
  send({ type: "painted", ago: paintedAt.map((at) => now - at) });
  paintedAt = [];
}, PAINTED_EVERY_MS);

send({ type: "ready" }, [line.port2]);
