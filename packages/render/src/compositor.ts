// oxlint-disable-next-line typescript/triple-slash-reference -- packages that bundle this need it too
/// <reference path="./virtual.d.ts" />
import code from "virtual:animaquill-scene-runtime";
import soundCode from "virtual:animaquill-sound-runtime";
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from "mediabunny";
import type { RenderLayer, RenderPlan } from "@animaquill/core";
import {
  boxOf,
  clockOf,
  fitIn,
  layerMatrix,
  multiply,
  opacityAt,
  viewMatrix,
  type Matrix,
} from "@animaquill/core/view";
import { comesUpAfter, readingAt, showsAt, VideoCursor } from "./cursor.ts";
import { GiveUpTimer } from "./patience.ts";
import { withChannels } from "./plan.ts";
import { placeholderPicture } from "./placeholder.ts";
import { SceneLayers } from "./scenes.ts";
import { SoundJobs } from "./sounds.ts";
import type { FrameTiming, FromCompositor, ToCompositor } from "./index.ts";

/**
 * The compositor. It runs in a sandbox on a site of its own, where it can decode, draw and later
 * encode without network or storage. Everything it gets comes from the editor as a message.
 */

interface Picture {
  readonly width: number;
  readonly height: number;
  /** Draws a part of it, in its pixels, on the same pixels of whatever the matrix says. */
  draw(x: number, y: number, width: number, height: number): void;
  close(): void;
}

const TIMINGS_EVERY_MS = 500;
/** Often enough that the editor can count the last second without waiting for the next word. */
const PAINTED_EVERY_MS = 250;

interface VideoFile {
  readonly sink: VideoSampleSink;
}

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
const images = new Map<string, Promise<ImageBitmap | undefined>>();
const videos = new Map<string, Promise<VideoFile | undefined>>();
const asked = new Set<string>();
/** By layer, because two clips of one file read different places. */
const cursors = new Map<
  string,
  { readonly file: string; readonly cursor: VideoCursor<VideoSample> }
>();

let wanted = 0;
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
  if (track && (await track.canDecode())) return { sink: new VideoSampleSink(track) };
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
  draw(x, y, width, height) {
    draw.drawImage(bitmap, x, y, width, height, x, y, width, height);
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
  draw(x, y, width, height) {
    if (sample.rotation !== 0 || sample.flip) {
      sample.draw(draw, x, y, width, height, x, y, width, height);
    } else {
      draw.drawImage(sample.toCanvasImageSource(), x, y, width, height, x, y, width, height);
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
  const sample = await cursor?.at(clockOf(layer, seconds));
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
    await cursor?.at(layer.offset);
    cursor?.takeCold();
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

/** Colors and pictures are one kind of thing here: a box in the world, with something in it. */
function paint(
  layer: RenderLayer,
  picture: Picture | undefined,
  view: Matrix,
  seconds: number,
  stage: RenderPlan["stage"],
): void {
  const { source } = layer;
  const opacity = opacityAt(layer, seconds);
  if (opacity <= 0 || (source.kind !== "color" && !picture)) return;
  // A scene is laid out for its box, so its picture says nothing about what that box is.
  const box = boxOf(layer, seconds, source.kind === "scene" ? undefined : picture, stage);
  if (box.width <= 0 || box.height <= 0) return;
  const toPicture = multiply(view, layerMatrix(layer, seconds, box));
  draw.globalAlpha = opacity;
  if (picture) {
    const { source: part, matrix } = fitIn(layer.fit, picture, box);
    const fromMedia = multiply(toPicture, matrix);
    if (!canUse(fromMedia)) return;
    draw.setTransform(...fromMedia);
    picture.draw(part.x, part.y, part.width, part.height);
  } else if (source.kind === "color" && canUse(toPicture)) {
    draw.setTransform(...toPicture);
    draw.fillStyle = source.color;
    draw.fillRect(0, 0, box.width, box.height);
  }
}

/** Everything is decoded first, so that a frame appears whole and never half drawn. */
async function drawFrame(seconds: number): Promise<boolean> {
  const shown = plan;
  if (!shown) return false;
  const showing = shown.layers.filter((layer) => showsAt(layer, seconds));
  await closeCursorsExcept([...showing, ...upcomingAt(seconds)]);
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
  draw.fillStyle = shown.background;
  draw.fillRect(0, 0, canvas.width, canvas.height);
  const view = viewMatrix(shown, seconds);
  showing.forEach((layer, index) => {
    paint(layer, pictures[index], view, seconds, shown.stage);
  });
}

/** One frame at a time. When time runs ahead of it, frames in between are skipped. */
async function refresh(): Promise<void> {
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
  const { data } = event;
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
  } else files.set(data.id, data.file);
  try {
    scenes.follow(settledPlan, wanted);
  } finally {
    // Whatever went wrong with a scene, the rest of the picture goes on.
    void refresh();
  }
});

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

send({ type: "ready" });
