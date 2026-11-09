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
import { showsAt } from "./cursor.ts";
import { FrameLoop, type PendingFrame } from "./frame-loop.ts";
import type { Corners } from "./transitions/code.ts";
import { VideoReads } from "./reads.ts";
import { withChannels } from "./plan.ts";
import { videoPicture, type Picture } from "./picture.ts";
import { videoLayerFrame, type VideoLayerParts } from "./video-layer.ts";
import { placeholderPicture } from "./placeholder.ts";
import { SceneLayers } from "./scenes.ts";
import { SlowVideos } from "./slow-videos.ts";
import { SoundJobs } from "./sounds.ts";
import { failureOf, FileArrivals, stillPictures, StillFailed } from "./still.ts";
import type {
  ColdClip,
  FrameTiming,
  FrameToEncode,
  FromCompositor,
  ToCompositor,
} from "./index.ts";

/**
 * The compositor. It runs in a sandbox on a site of its own, where it can decode, draw and later
 * encode without network or storage. Everything it gets comes from the editor as a message.
 */

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
  /** As it shows, for telling which videos are hard to decode. */
  readonly width: number;
  readonly height: number;
  /** How large the video shows that this file is a smaller copy of, see "file". */
  readonly standsFor?: StandsFor | undefined;
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
/** What a file that stands in for a video stands in for, see "file". */
interface StandsFor {
  readonly width: number;
  readonly height: number;
}

/** Files that stand in for a video, by id, with how large that video shows and which one each is. */
const standIns = new Map<string, StandsFor & { readonly serial: number }>();
/** Stand-ins that could not be read, which the editor heard of once. */
const failedStandIns = new Set<Blob>();
const arrivals = new FileArrivals();
const images = new Map<string, Promise<ImageBitmap | undefined>>();
/** By id, with the file each was opened from: another file for the id is another video. */
const videos = new Map<
  string,
  { readonly file: Blob; readonly video: Promise<VideoFile | undefined> }
>();
const asked = new Set<string>();
const reads = new VideoReads<VideoSample>();

/** One at a time: they draw on the same canvas and read the same videos. */
let stills: Promise<void> = Promise.resolve();
let recording = false;
let timings: FrameTiming[] = [];
/** When frames of a new place on the timeline reached the canvas, since the editor last heard. */
let paintedAt: number[] = [];
/** Long tasks while recording, with when they started on this clock. */
let longTasks: { readonly ms: number; readonly at: number }[] = [];

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

/** What a read gets once what it reads was let go of, for another file: no failure of the file. */
const isLetGo = (error: unknown) => error instanceof Error && error.name === "InputDisposedError";

/**
 * The editor hears once that a stand-in cannot be read, and sends the video itself: that it cannot
 * be decoded is not something people need to hear about. A file that another one took the place of
 * meanwhile, as when people choose full quality, is none of that.
 */
function cannotDecode(
  id: string,
  file: Blob,
  standsFor: VideoFile["standsFor"],
  error?: unknown,
): void {
  if (!standsFor) {
    send({ type: "cannot-decode", id });
    return;
  }
  if (files.get(id) !== file || isLetGo(error) || failedStandIns.has(file)) return;
  failedStandIns.add(file);
  // Of the file the id reads, which is the one the editor sent last.
  send({ type: "stand-in-failed", id, serial: standIns.get(id)?.serial ?? -1 });
}

async function openVideo(
  id: string,
  file: Blob,
  standsFor: VideoFile["standsFor"],
): Promise<VideoFile | undefined> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (track && (await track.canDecode())) {
    const { displayWidth: width, displayHeight: height } = track;
    return { sink: new VideoSampleSink(track), input, width, height, standsFor };
  }
  input.dispose();
  cannotDecode(id, file, standsFor);
  return undefined;
}

function videoOf(id: string, file: Blob): Promise<VideoFile | undefined> {
  // What a frame on its way asks for after another file took the place of this one, as a stand-in
  // does: nothing, or it would stay what the id reads. The next frame reads the new file.
  if (files.get(id) !== file) return Promise.resolve(undefined);
  const known = videos.get(id);
  if (known?.file === file) return known.video;
  // One of a file before this one, which nothing reads any more.
  void known?.video.then((video) => video?.input.dispose());
  // Along with the file it came with: the next file for the id comes with its own.
  const standIn = standIns.get(id);
  const standsFor = standIn && { width: standIn.width, height: standIn.height };
  const video = openVideo(id, file, standsFor).catch((error: unknown) => {
    cannotDecode(id, file, standsFor, error);
    return undefined;
  });
  videos.set(id, { file, video });
  return video;
}

/** Which clip had to start decoding, by id and size only. */
const coldClipOf = (layer: RenderLayer, video: VideoFile): ColdClip => ({
  layer: layer.id,
  kind: "video",
  width: video.width,
  height: video.height,
  ...(video.standsFor && { standIn: true }),
});

const imagePicture = (bitmap: ImageBitmap | OffscreenCanvas, close = () => {}): Picture => ({
  width: bitmap.width,
  height: bitmap.height,
  draw(target, x, y, width, height) {
    target.drawImage(bitmap, x, y, width, height, x, y, width, height);
  },
  close,
});

/** Whatever a scene has last. It runs at its own pace, and frames in between just do not show. */
function scenePictureOf({ id }: RenderLayer): Picture | undefined {
  const held = scenes.pictureOf(id);
  if (held) return imagePicture(held.image, held.release);
  return scenes.showsPlaceholder(id) ? imagePicture(placeholderPicture()) : undefined;
}

async function pictureOf(layer: RenderLayer, frame: PendingFrame): Promise<Picture | undefined> {
  const { source } = layer;
  if (source.kind === "color") return undefined;
  if (source.kind === "scene") return scenePictureOf(layer);
  const file = fileOf(source.file);
  if (!file) return undefined;
  if (source.kind === "image") {
    const bitmap = await imageOf(source.file, file);
    return bitmap && imagePicture(bitmap);
  }
  const startedAt = performance.now();
  const read = await videoLayerFrame(videoParts, layer, source.file, file, frame);
  if (!read) return undefined;
  const standIn = read.video.standsFor !== undefined;
  frame.videos.push({ file: source.file, ms: performance.now() - startedAt, standIn });
  if (read.cold) frame.cold.push(coldClipOf(layer, read.video));
  return read.sample && videoPicture(read.sample, read.video.standsFor);
}

/** What reading the frame of a video layer needs, see `videoLayerFrame`. */
const videoParts: VideoLayerParts<VideoFile, VideoSample> = {
  fileOf: (id) => files.get(id),
  videoOf,
  frameAt: (layer, id, video, seconds) => reads.frameAt(layer, id, video.sink, seconds),
  readFailed(id, file, video, error) {
    // A stand-in that cannot be read, such as one that went away, gives way to the video.
    if (video.standsFor) cannotDecode(id, file, video.standsFor, error);
  },
};

/** Gets a clip that starts soon ready, see `FrameLoop`. */
async function getReady(layer: RenderLayer, seconds: number): Promise<void> {
  const { source } = layer;
  if (source.kind === "color" || source.kind === "scene") return;
  const file = fileOf(source.file);
  if (!file) return;
  if (source.kind === "image") {
    await imageOf(source.file, file);
    return;
  }
  const video = await videoOf(source.file, file);
  if (video) await reads.prepare(layer, source.file, video.sink, seconds);
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
  const reading = reads.files();
  const stale = [...lastNeeded]
    .filter(([id, at]) => at !== needs && !reading.has(id))
    .toSorted(([, a], [, b]) => b - a)
    .slice(KEEP_FILES);
  for (const [id] of stale) {
    lastNeeded.delete(id);
    void images.get(id)?.then((bitmap) => bitmap?.close());
    images.delete(id);
    void videos.get(id)?.video.then((video) => video?.input.dispose());
    videos.delete(id);
  }
  // For seeing how much is held, also from a test.
  document.documentElement.dataset["pictures"] = String(images.size);
  document.documentElement.dataset["videos"] = String(videos.size);
}

/** For seeing what stands in for videos, also from a test. */
function showStandIns(): void {
  document.documentElement.dataset["standIns"] = String(standIns.size);
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
  const video = videos.get(id)?.video;
  videos.delete(id);
  try {
    await reads.forget(id);
    await image?.then((bitmap) => bitmap?.close());
    await video?.then((opened) => opened?.input.dispose());
  } finally {
    void loop.refresh();
  }
}

/** A decoder is a scarce thing, so a clip that left the picture gives its own back. */
const closeCursorsExcept = (keep: readonly RenderLayer[]): Promise<void> =>
  reads.closeExcept(new Set(keep.map(({ id }) => id)));

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
async function drawFrame(frame: PendingFrame): Promise<boolean> {
  const shown = plan;
  if (!shown) return false;
  const { seconds } = frame;
  const showing = loop.showing(seconds);
  const needed = [...showing, ...loop.upcoming(seconds)];
  await closeCursorsExcept(needed);
  releaseFilesExcept(needed);
  const askedAt = performance.now();
  // A picture of a scene is held until it is drawn, so one that fails must not keep the others.
  const results = await Promise.allSettled(showing.map((layer) => pictureOf(layer, frame)));
  const pictures = results.map((result) =>
    result.status === "fulfilled" ? result.value : undefined,
  );
  frame.decodeMs = performance.now() - askedAt;
  try {
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    if (frame.givenUp) return false;
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

/** Whether time goes on by itself, from what the editor says, see "play". */
let playing = false;
/** Videos that decode too slowly while playing, which the editor hears of once each. */
const slowVideos = new SlowVideos();

/** How long a frame of the project lasts. */
function frameMsOf(shown: RenderPlan | undefined): number {
  const fps = shown?.scenes.fps;
  return fps && fps.num > 0 && fps.den > 0 ? (1000 * fps.den) / fps.num : 1000 / 30;
}

/** One frame at a time, see `FrameLoop`. */
const loop = new FrameLoop({
  layers: () => plan?.layers ?? [],
  draw: drawFrame,
  prepare: getReady,
  giveUpFor: (seconds) => reads.giveUpFor(plan?.layers ?? [], seconds),
  drew(timing, newPlace, frame) {
    if (newPlace) paintedAt.push(performance.now());
    if (recording) timings.push(timing);
    // Moving the playhead starts decoding over anyway: only time going on says how it keeps up.
    if (!playing || frame.jumped || frame.videos.length === 0) return;
    const played = {
      at: performance.now(),
      frameMs: frameMsOf(plan),
      behindMs: timing.behindMs,
      videos: frame.videos,
    };
    for (const id of slowVideos.note(played)) send({ type: "slow-video", id });
  },
  wait(milliseconds, run) {
    const timer = setTimeout(run, milliseconds);
    return () => clearTimeout(timer);
  },
  now: () => performance.now(),
});
const refresh = () => loop.refresh();

/** The same painting as the preview, after waiting for everything that the preview goes without. */
async function paintStill(seconds: number): Promise<void> {
  const shown = plan;
  if (!shown) throw new StillFailed({ reason: "failed", message: "No plan" });
  loop.wanted = seconds;
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
      const video = await videoOf(id, file);
      if (!video) return undefined;
      const read = await reads.frameAt(layer, id, video.sink, seconds);
      return read.frame && videoPicture(read.frame, video.standsFor);
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
  // Scenes follow time with these too.
  if (data.type === "play") playing = true;
  else if (data.type === "pause") playing = false;
  if (sounds.handle(data)) return;
  if (scenes.handle(data)) return;
  if (data.type === "strip") {
    void answerStrip(data.request, data.file, data.count, data.height);
    return;
  }
  if (data.type === "record") {
    recording = data.on;
    watchLongTasks(data.on);
    return;
  }
  if (data.type === "exporting") {
    loop.exporting = true;
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
    stills = stills.then(() => answerEncoding(request, loop.exporting ? work : notExporting));
    return;
  }
  if (data.type === "no-file") {
    // Somebody may bring it back, so that the next one gets to ask again.
    asked.delete(data.id);
    // It went away after it came, as a file of a project folder can: what was read of it goes too.
    standIns.delete(data.id);
    if (files.delete(data.id)) void forgetRead(data.id);
    showStandIns();
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
    loop.seek(data.seconds, data.jump);
  } else {
    const before = files.get(data.id);
    const wasStandIn = standIns.get(data.id);
    const { standIn } = data;
    const isOtherSize =
      wasStandIn?.width !== standIn?.width || wasStandIn?.height !== standIn?.height;
    if (standIn) {
      const { width, height, serial } = standIn;
      standIns.set(data.id, { width, height, serial });
    } else standIns.delete(data.id);
    // The same content in another file, as after the file changed on the disk: the old one cannot
    // be read any more. The same file of a disk again, as when it is sent twice, is nothing new.
    // A stand-in and its video are other files, and the picture goes on at the same moment.
    if (before && (!isSameFile(before, data.file) || isOtherSize)) {
      files.set(data.id, data.file);
      void forgetRead(data.id);
    } else if (!before) {
      files.set(data.id, data.file);
    }
    arrivals.settle(data.id, data.file);
    showStandIns();
  }
  // It goes where `still` says, and a scene at the start of the plan is not worth opening for nothing.
  if (loop.exporting) return;
  try {
    scenes.follow(settledPlan, loop.wanted, plan);
  } finally {
    // Whatever went wrong with a scene, the rest of the picture goes on.
    void refresh();
  }
}

/** The editor sees long tasks of its own page only, and this one runs on a site of its own. */
let longTaskObserver: PerformanceObserver | undefined;
function watchLongTasks(on: boolean): void {
  longTaskObserver?.disconnect();
  longTaskObserver = undefined;
  longTasks = [];
  if (!on || !PerformanceObserver.supportedEntryTypes.includes("longtask")) return;
  longTaskObserver = new PerformanceObserver((list) => {
    for (const { duration, startTime } of list.getEntries()) {
      longTasks.push({ ms: Math.round(duration), at: startTime });
    }
  });
  longTaskObserver.observe({ type: "longtask" });
}

setInterval(() => {
  if (timings.length > 0) {
    send({ type: "frames", frames: timings });
    timings = [];
  }
  if (longTasks.length > 0) {
    const now = performance.now();
    send({ type: "long-tasks", tasks: longTasks.map(({ ms, at }) => ({ ms, ago: now - at })) });
    longTasks = [];
  }
}, TIMINGS_EVERY_MS);

setInterval(() => {
  if (paintedAt.length === 0) return;
  // Each side has a clock of its own, so this says how long ago, and the editor counts back from when it heard.
  const now = performance.now();
  send({ type: "painted", ago: paintedAt.map((at) => now - at) });
  paintedAt = [];
}, PAINTED_EVERY_MS);

send({ type: "ready" }, [line.port2]);
