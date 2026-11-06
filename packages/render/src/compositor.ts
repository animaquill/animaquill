import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from "mediabunny";
import type { RenderLayer, RenderPlan } from "@animaquill/core";
import type { FrameTiming, FromCompositor, ToCompositor } from "./index.ts";

/**
 * The compositor. It runs in a sandbox on a site of its own, where it can decode, draw and later
 * encode without network or storage. Everything it gets comes from the editor as a message.
 */

interface Picture {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  close(): void;
}

const TIMINGS_EVERY_MS = 500;
/** Longer than any file takes to open, short enough to hold only the next clip or two. */
const GET_READY_SECONDS = 1.5;

/** A jump this far ahead is cheaper by starting over at a keyframe than by decoding the way there. */
const MAX_WALK_SECONDS = 2;

/**
 * Reads a video forwards, because a frame in the middle of a file costs decoding everything since
 * the last keyframe. Going on from the last frame is what makes playing possible.
 */
class VideoCursor {
  readonly #sink: VideoSampleSink;
  #samples: AsyncGenerator<VideoSample, void, unknown> | undefined;
  #current: VideoSample | undefined;
  #next: VideoSample | undefined;
  /** Whether decoding started over since it was last asked. */
  #cold = false;
  /** Getting ready and drawing can ask at once, and a generator takes one question at a time. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(sink: VideoSampleSink) {
    this.#sink = sink;
  }

  async #pull(): Promise<VideoSample | undefined> {
    const result = await this.#samples?.next();
    return result?.done === false ? result.value : undefined;
  }

  takeCold(): boolean {
    const cold = this.#cold;
    this.#cold = false;
    return cold;
  }

  async #restart(seconds: number): Promise<void> {
    await this.#release();
    this.#cold = true;
    this.#samples = this.#sink.samples(seconds);
    this.#current = await this.#pull();
    this.#next = await this.#pull();
  }

  #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#queue.then(work);
    this.#queue = turn.catch(() => {});
    return turn;
  }

  /** The frame showing at a moment. It stays open until the cursor moves on. */
  at(seconds: number): Promise<VideoSample | undefined> {
    return this.#inTurn(() => this.#moveTo(seconds));
  }

  close(): Promise<void> {
    return this.#inTurn(() => this.#release());
  }

  async #moveTo(seconds: number): Promise<VideoSample | undefined> {
    const current = this.#current;
    const behind = current === undefined || seconds < current.timestamp;
    const farAhead = this.#next && seconds - this.#next.timestamp > MAX_WALK_SECONDS;
    if (behind || farAhead) await this.#restart(seconds);
    while (this.#next && this.#next.timestamp <= seconds) {
      this.#current?.close();
      this.#current = this.#next;
      this.#next = await this.#pull();
    }
    return this.#current;
  }

  async #release(): Promise<void> {
    this.#current?.close();
    this.#next?.close();
    this.#current = undefined;
    this.#next = undefined;
    await this.#samples?.return();
    this.#samples = undefined;
  }
}

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
Object.assign(canvas.style, { maxWidth: "100%", maxHeight: "100%", display: "block" });
document.body.append(canvas);

const send = (message: FromCompositor, transfer: Transferable[] = []) =>
  parent.postMessage(message, "*", transfer);

let plan: RenderPlan | undefined;
const files = new Map<string, Blob>();
const images = new Map<string, Promise<ImageBitmap | undefined>>();
const videos = new Map<string, Promise<VideoFile | undefined>>();
const asked = new Set<string>();
/** By layer, because two clips of one file read different places. */
const cursors = new Map<string, { readonly file: string; readonly cursor: VideoCursor }>();

let wanted = 0;
let gettingReady = false;
let recording = false;
let coldInFrame = 0;
let timings: FrameTiming[] = [];
let drawing = false;
let drawAgain = false;

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
): Promise<VideoCursor | undefined> {
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

async function pictureOf(layer: RenderLayer, seconds: number): Promise<Picture | undefined> {
  const { source } = layer;
  if (source.kind === "color") return undefined;
  const file = fileOf(source.file);
  if (!file) return undefined;
  if (source.kind === "image") {
    const bitmap = await imageOf(source.file, file);
    return bitmap && { source: bitmap, width: bitmap.width, height: bitmap.height, close() {} };
  }
  const cursor = await cursorOf(layer, source.file, file);
  const sample = await cursor?.at(layer.offset + seconds - layer.start);
  if (cursor?.takeCold()) coldInFrame += 1;
  if (!sample) return undefined;
  return {
    source: sample.toCanvasImageSource(),
    width: sample.displayWidth,
    height: sample.displayHeight,
    close() {},
  };
}

/** Clips that start soon. */
const upcomingAt = (seconds: number): readonly RenderLayer[] =>
  plan?.layers.filter(({ start }) => start > seconds && start - seconds <= GET_READY_SECONDS) ?? [];

/**
 * Opening a file and decoding up to a first frame takes longer than a frame may, so a clip does that
 * before it shows, and playing goes straight from one clip into the next.
 */
async function getReady(seconds: number): Promise<void> {
  for (const layer of upcomingAt(seconds)) {
    const { source } = layer;
    if (source.kind === "color") continue;
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

function place(layer: RenderLayer, picture: Picture): void {
  const scaleOf = layer.fit === "cover" ? Math.max : Math.min;
  const scale = scaleOf(canvas.width / picture.width, canvas.height / picture.height);
  const width = picture.width * scale;
  const height = picture.height * scale;
  draw.drawImage(
    picture.source,
    (canvas.width - width) / 2,
    (canvas.height - height) / 2,
    width,
    height,
  );
}

/** Everything is decoded first, so that a frame appears whole and never half drawn. */
async function drawFrame(seconds: number): Promise<void> {
  if (!plan) return;
  const showing = plan.layers.filter(({ start, end }) => seconds >= start && seconds < end);
  await closeCursorsExcept([...showing, ...upcomingAt(seconds)]);
  const pictures = await Promise.all(showing.map((layer) => pictureOf(layer, seconds)));
  if (canvas.width !== plan.width) canvas.width = plan.width;
  if (canvas.height !== plan.height) canvas.height = plan.height;
  draw.globalAlpha = 1;
  draw.fillStyle = plan.background;
  draw.fillRect(0, 0, canvas.width, canvas.height);
  showing.forEach((layer, index) => {
    draw.globalAlpha = layer.opacity;
    const picture = pictures[index];
    if (layer.source.kind === "color") {
      draw.fillStyle = layer.source.color;
      draw.fillRect(0, 0, canvas.width, canvas.height);
    } else if (picture) {
      place(layer, picture);
    }
  });
  for (const picture of pictures) picture?.close();
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
    const seconds = wanted;
    const started = performance.now();
    coldInFrame = 0;
    try {
      await drawFrame(seconds);
    } catch (error) {
      console.warn("A frame could not be drawn", error);
    }
    if (!gettingReady) {
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
      timings.push({ seconds, ms, cold: coldInFrame, behindMs });
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

addEventListener("message", ({ data, source }: MessageEvent<ToCompositor>) => {
  if (source !== parent) return;
  if (data.type === "strip") {
    void answerStrip(data.request, data.file, data.count, data.height);
    return;
  }
  if (data.type === "record") {
    recording = data.on;
    return;
  }
  if (data.type === "plan") plan = data.plan;
  else if (data.type === "seek") wanted = data.seconds;
  else files.set(data.id, data.file);
  void refresh();
});

setInterval(() => {
  if (timings.length === 0) return;
  send({ type: "frames", frames: timings });
  timings = [];
}, TIMINGS_EVERY_MS);

send({ type: "ready" });
