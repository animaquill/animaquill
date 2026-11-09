/**
 * A smaller copy of a video for the preview, a proxy: a decoder that cannot decode a large video
 * fast enough, as a laptop with 4K at 60 frames, can decode this. Only the preview plays it, an
 * export never does. It runs where a worker has WebCodecs, see the proxy worker of the editor.
 */
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from "mediabunny";
import { VideoFileWriter, type ByteSink } from "./video-file.ts";

/**
 * Moments this close are the same moment, as the compositor takes them when it finds the frame of a
 * moment: `TIME_TOLERANCE` in core/view.ts, which this has to agree with.
 */
export const SAME_MOMENT = 1e-6;

/** How far apart decoding can start, which is what jumping around a video costs at most. */
export const KEY_SECONDS = 0.5;

/** Frames per second, as exact as the project has them. */
export interface FrameRate {
  readonly num: number;
  readonly den: number;
}

/** What a proxy is like: its pixels, as it shows, and the rate of its frames. */
export interface ProxyShape {
  readonly width: number;
  readonly height: number;
  readonly fps: FrameRate;
}

/** A frame as a decoder gives it. Times are in seconds. */
export interface TimedSample {
  readonly timestamp: number;
  readonly duration: number;
  close(): void;
}

/** A frame that goes into a proxy. */
export interface PickedFrame<S extends TimedSample> {
  /** What to draw. Whoever gets it closes it. */
  readonly sample: S;
  /** Seconds, on a moment of the rate. */
  readonly timestamp: number;
  readonly duration: number;
  /** Decoding can start here. */
  readonly key: boolean;
}

/**
 * The frames of a proxy at a rate of its own: for each moment of the rate, the frame that the video
 * shows then, found the way the compositor finds it: the last one that starts at that moment or
 * before, and the first one before the video starts. One that shows at several moments in a row
 * comes once, for all of them, and frames that show at none go. So at every moment of the rate the
 * proxy shows what the video does, and going from one to the other shows no jump. Every frame at
 * least `keyEvery` seconds after the last key frame is one.
 */
export async function* pickFrames<S extends TimedSample>(
  samples: AsyncIterable<S>,
  rate: FrameRate,
  keyEvery = KEY_SECONDS,
): AsyncGenerator<PickedFrame<S>, void, undefined> {
  const iterator = samples[Symbol.asyncIterator]();
  /** The next frame with a time to go by. One without cannot be shown at any moment. */
  const pull = async (): Promise<S | undefined> => {
    for (;;) {
      const result = await iterator.next();
      if (result.done) return undefined;
      if (Number.isFinite(result.value.timestamp)) return result.value;
      result.value.close();
    }
  };
  const at = (index: number) => (index * rate.den) / rate.num;
  /** The first moment that comes at a time or after it, or one or two before. Never one after. */
  const nearlyAt = (seconds: number) =>
    Math.floor(((seconds - SAME_MOMENT) * rate.num) / rate.den) - 1;
  let current: S | undefined;
  let next: S | undefined;
  /** A frame that shows from a moment on, until it is clear how long. */
  let pending: { readonly sample: S; readonly start: number } | undefined;
  let lastKey = Number.NEGATIVE_INFINITY;
  const out = (until: number): PickedFrame<S> => {
    const { sample, start } = pending as { readonly sample: S; readonly start: number };
    pending = undefined;
    const key = start - lastKey >= keyEvery - SAME_MOMENT;
    if (key) lastKey = start;
    return { sample, timestamp: start, duration: until - start, key };
  };
  try {
    current = await pull();
    if (!current) return;
    next = await pull();
    for (let index = 0; ;) {
      const moment = at(index);
      while (next && next.timestamp <= moment + SAME_MOMENT) {
        if (pending?.sample !== current) current.close();
        current = next;
        next = await pull();
      }
      if (pending?.sample !== current) {
        if (pending) yield out(moment);
        pending = { sample: current, start: moment };
      }
      if (!next) {
        // The last frame shows until the video ends: up to the first moment of the rate then.
        const end = current.timestamp + Math.max(current.duration, 0);
        let stop = Math.max(index + 1, nearlyAt(end));
        while (at(stop) < end - SAME_MOMENT) stop += 1;
        // It is the one that goes out now, and belongs to whoever gets it.
        current = undefined;
        yield out(at(stop));
        return;
      }
      // Nothing changes before the next frame starts, however far off that is.
      index = Math.max(index + 1, nearlyAt(next.timestamp));
    }
  } finally {
    // What did not go out. What did belongs to whoever got it.
    for (const sample of new Set([pending?.sample, current, next])) sample?.close();
    await iterator.return?.();
  }
}

/** Why there is no proxy. */
export type ProxyFailure =
  /** This browser cannot decode the video. */
  | "unreadable"
  /** This browser cannot encode H.264, which is what proxies are. */
  | "unsupported"
  /** Encoding stopped with an error of the encoder. */
  | "encoder"
  /** The file could not be read to the end, as when it changed meanwhile. */
  | "read";

export class ProxyFailed extends Error {
  override readonly name = "ProxyFailed";
  readonly reason: ProxyFailure;

  constructor(reason: ProxyFailure, options?: { readonly cause?: unknown }) {
    super(`No proxy: ${reason}`, options);
    this.reason = reason;
  }
}

export interface ProxyControl {
  /** Stops making it. It rejects with the reason then, and the sink gets nothing more. */
  readonly signal?: AbortSignal;
  /**
   * Resolves once it may go on, before each frame: something that plays needs the decoder more. It
   * holds on to what it decodes and encodes with meanwhile.
   */
  readonly whenFree?: () => Promise<void>;
  /** How far it got, as a share of the length of the video. */
  readonly onProgress?: (share: number) => void;
}

/** Where the time of making a proxy went, in milliseconds, for telling what holds it up. */
export interface ProxyTiming {
  readonly totalMs: number;
  /** Waiting for frames of the video. */
  readonly decodeMs: number;
  /** Drawing them smaller. */
  readonly drawMs: number;
  /** Making frames for the encoder of that. */
  readonly frameMs: number;
  /** Waiting for the encoder and the file. */
  readonly encodeMs: number;
  /** Waiting while something played, which is part of the total. */
  readonly pausedMs: number;
}

/** What a proxy came out like. */
export interface ProxyResult {
  readonly frames: number;
  readonly keys: number;
  /** Seconds, as long as the video, up to the next moment of the rate. */
  readonly duration: number;
  /** Seconds of the video it is of, as its frames go. */
  readonly sourceDuration: number;
  readonly timing?: ProxyTiming;
}

/** Frames waiting in the encoder. More only take memory, and the encoder works through them anyway. */
const ENCODER_QUEUE = 4;
/** Encoded frames waiting for the file. They are small, but a slow disk should hold things up. */
const WRITE_QUEUE = 16;

const micro = (seconds: number) => Math.round(seconds * 1e6);

/** Until the encoder has room, or failed. It says so with an event, which it may not send then. */
async function roomIn(encoder: VideoEncoder): Promise<void> {
  while (encoder.encodeQueueSize > ENCODER_QUEUE && encoder.state === "configured") {
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
}

/** The first of these that this browser can encode with, best first. */
async function firstSupported(
  configs: readonly VideoEncoderConfig[],
): Promise<VideoEncoderConfig | undefined> {
  if (typeof VideoEncoder === "undefined") return undefined;
  for (const config of configs) {
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

/**
 * Draws a frame smaller, halving it as often as it takes after a first draw: once a picture gets
 * smaller than half, drawing skips pixels and the result shimmers, which halving does not do. Half
 * itself is fine, so 4K goes to a quarter in two steps: to half, then to a quarter.
 */
class Shrinker {
  readonly canvas: OffscreenCanvas;
  readonly #context: OffscreenCanvasRenderingContext2D;
  #larger: { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D } | undefined;

  constructor(width: number, height: number) {
    this.canvas = new OffscreenCanvas(width, height);
    const context = this.canvas.getContext("2d", { alpha: false });
    if (!context) throw new ProxyFailed("unsupported");
    context.imageSmoothingQuality = "high";
    this.#context = context;
  }

  draw(sample: VideoSample): void {
    const { width, height } = this.canvas;
    const ratio = Math.min(sample.displayWidth / width, sample.displayHeight / height);
    // The first draw makes it at most half as large, the rest halves it.
    const halvings = ratio > 2 ? Math.ceil(Math.log2(ratio)) - 1 : 0;
    if (halvings === 0) {
      sample.draw(this.#context, 0, 0, width, height);
      return;
    }
    const scale = 2 ** halvings;
    if (this.#larger?.canvas.width !== width * scale) {
      const canvas = new OffscreenCanvas(width * scale, height * scale);
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new ProxyFailed("unsupported");
      context.imageSmoothingQuality = "high";
      this.#larger = { canvas, context };
    }
    const { canvas, context } = this.#larger;
    // Rotation and mirroring as the video says, which only the sample knows how to do.
    sample.draw(context, 0, 0, width * scale, height * scale);
    context.globalCompositeOperation = "copy";
    for (let level = scale; level > 2; level /= 2) {
      context.drawImage(
        canvas,
        0,
        0,
        width * level,
        height * level,
        0,
        0,
        (width * level) / 2,
        (height * level) / 2,
      );
    }
    context.globalCompositeOperation = "source-over";
    this.#context.drawImage(canvas, 0, 0, width * 2, height * 2, 0, 0, width, height);
  }
}

/**
 * Makes a proxy of a video: H.264 in MP4, without sound, at the shape given, with a key frame every
 * `KEY_SECONDS`, see `pickFrames`. The file goes to the sink as it comes, which is never all of it
 * at once, and is complete once this resolves. `encoders` are what to encode with, best first: the
 * first one this browser takes. Rejects with a `ProxyFailed`, or with the reason of the signal.
 */
export async function makeProxy(
  file: Blob,
  shape: ProxyShape,
  encoders: readonly VideoEncoderConfig[],
  sink: ByteSink,
  { signal, whenFree, onProgress }: ProxyControl = {},
): Promise<ProxyResult> {
  signal?.throwIfAborted();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let encoder: VideoEncoder | undefined;
  let writer: VideoFileWriter | undefined;
  let finished = false;
  try {
    const track = await input.getPrimaryVideoTrack().catch((error: unknown) => {
      throw new ProxyFailed("read", { cause: error });
    });
    if (!track || !(await track.canDecode())) throw new ProxyFailed("unreadable");
    const sourceDuration = await track.computeDuration();
    const config = await firstSupported(encoders);
    if (!config) throw new ProxyFailed("unsupported");
    const fps = shape.fps.num / shape.fps.den;
    const opened = await VideoFileWriter.start(sink, { codec: "avc", frameRate: fps });
    writer = opened;
    let failure: unknown;
    let writes: Promise<void> = Promise.resolve();
    let waiting = 0;
    let first = true;
    const current = new VideoEncoder({
      output(chunk, meta) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const frame = {
          data,
          key: chunk.type === "key",
          timestamp: chunk.timestamp / 1e6,
          duration: (chunk.duration ?? 0) / 1e6,
        };
        const decoderConfig = first ? meta?.decoderConfig : undefined;
        first = false;
        waiting += 1;
        writes = writes
          .then(() => opened.add(frame, decoderConfig))
          .catch((error: unknown) => {
            failure ??= error;
          })
          .finally(() => {
            waiting -= 1;
          });
      },
      error(error) {
        failure ??= new ProxyFailed("encoder", { cause: error });
      },
    });
    encoder = current;
    try {
      current.configure({ ...config, width: shape.width, height: shape.height });
    } catch (error) {
      throw new ProxyFailed("encoder", { cause: error });
    }
    const shrinker = new Shrinker(shape.width, shape.height);
    const sampleSink = new VideoSampleSink(track);
    let frames = 0;
    let keys = 0;
    let end = 0;
    const started = performance.now();
    const spent = { decodeMs: 0, drawMs: 0, frameMs: 0, encodeMs: 0, pausedMs: 0 };
    let mark = started;
    /** Where the time since the last mark went. */
    const lap = (on: keyof typeof spent) => {
      const now = performance.now();
      spent[on] += now - mark;
      mark = now;
    };
    const picked = pickFrames(sampleSink.samples(), shape.fps);
    try {
      for (;;) {
        let step: IteratorResult<PickedFrame<VideoSample>>;
        mark = performance.now();
        try {
          step = await picked.next();
          lap("decodeMs");
        } catch (error) {
          throw new ProxyFailed("read", { cause: error });
        }
        if (step.done) break;
        const { sample, timestamp, duration, key } = step.value;
        try {
          signal?.throwIfAborted();
          if (failure) throw failure;
          shrinker.draw(sample);
        } finally {
          sample.close();
        }
        lap("drawMs");
        const frame = new VideoFrame(shrinker.canvas, {
          timestamp: micro(timestamp),
          duration: micro(duration),
        });
        lap("frameMs");
        try {
          current.encode(frame, { keyFrame: key });
        } catch (error) {
          throw failure ?? new ProxyFailed("encoder", { cause: error });
        } finally {
          frame.close();
        }
        frames += 1;
        if (key) keys += 1;
        end = timestamp + duration;
        onProgress?.(sourceDuration > 0 ? Math.min(end / sourceDuration, 1) : 0);
        await roomIn(current);
        // The disk keeps up, or what waits for it piles up in memory.
        if (waiting > WRITE_QUEUE) await writes;
        lap("encodeMs");
        // Something that plays wants the decoder: this waits, holding on to what it has.
        if (whenFree) await whenFree();
        lap("pausedMs");
        signal?.throwIfAborted();
      }
    } finally {
      await picked.return();
    }
    if (frames === 0) throw new ProxyFailed("unreadable");
    await current.flush().catch((error: unknown) => {
      throw failure ?? new ProxyFailed("encoder", { cause: error });
    });
    await writes;
    if (failure) throw failure;
    signal?.throwIfAborted();
    await opened.finish();
    finished = true;
    const round = (ms: number) => Math.round(ms);
    const timing = {
      totalMs: round(performance.now() - started),
      decodeMs: round(spent.decodeMs),
      drawMs: round(spent.drawMs),
      frameMs: round(spent.frameMs),
      encodeMs: round(spent.encodeMs),
      pausedMs: round(spent.pausedMs),
    };
    return { frames, keys, duration: end, sourceDuration, timing };
  } finally {
    if (encoder && encoder.state !== "closed") encoder.close();
    if (writer && !finished) await writer.cancel().catch(() => {});
    input.dispose();
  }
}

/** What a proxy has to be like to be used. */
export interface ProxyExpectation {
  readonly width: number;
  readonly height: number;
}

/**
 * Whether a file is a whole proxy of this shape: an MP4 with H.264 that can be read to its index,
 * which is at its end, so that a file that stopped halfway is none.
 */
export async function isProxy(file: Blob, { width, height }: ProxyExpectation): Promise<boolean> {
  if (file.size === 0) return false;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track?.codec !== "avc") return false;
    if (track.displayWidth !== width || track.displayHeight !== height) return false;
    const duration = await track.computeDuration();
    return Number.isFinite(duration) && duration > 0;
  } catch {
    return false;
  } finally {
    input.dispose();
  }
}
