import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import type { RenderLayer, RenderPlan } from "@animaquill/core";
import type { FromCompositor, ToCompositor } from "./index.ts";

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

const send = (message: FromCompositor) => parent.postMessage(message, "*");

let plan: RenderPlan | undefined;
const files = new Map<string, Blob>();
const images = new Map<string, Promise<ImageBitmap | undefined>>();
const videos = new Map<string, Promise<VideoFile | undefined>>();
const asked = new Set<string>();

let wanted = 0;
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

async function pictureOf(layer: RenderLayer, seconds: number): Promise<Picture | undefined> {
  const { source } = layer;
  if (source.kind === "color") return undefined;
  const file = fileOf(source.file);
  if (!file) return undefined;
  if (source.kind === "image") {
    const bitmap = await imageOf(source.file, file);
    return bitmap && { source: bitmap, width: bitmap.width, height: bitmap.height, close() {} };
  }
  const video = await videoOf(source.file, file);
  const sample = await video?.sink.getSample(layer.offset + seconds - layer.start);
  if (!sample) return undefined;
  return {
    source: sample.toCanvasImageSource(),
    width: sample.displayWidth,
    height: sample.displayHeight,
    close: () => sample.close(),
  };
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
    try {
      await drawFrame(wanted);
    } catch (error) {
      console.warn("A frame could not be drawn", error);
    }
  } while (drawAgain);
  drawing = false;
}

addEventListener("message", ({ data, source }: MessageEvent<ToCompositor>) => {
  if (source !== parent) return;
  if (data.type === "plan") plan = data.plan;
  else if (data.type === "seek") wanted = data.seconds;
  else files.set(data.id, data.file);
  void refresh();
});

send({ type: "ready" });
