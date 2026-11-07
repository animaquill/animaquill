import type { FromCompositor, ToCompositor } from "@animaquill/render";

/** Long enough for a large file on a slow computer. Without it a stuck frame would block all others. */
const TIMEOUT_MS = 60_000;

export const STRIP_HEIGHT = 54;

/** Frames in a strip: about one per second, within limits that keep it one reasonable image. */
export const stripCount = (seconds: number | undefined): number =>
  Math.min(Math.max(Math.ceil(seconds ?? 0), 8), 30);

/**
 * Asks a compositor of its own for frames of a video. Video only gets decoded in a sandbox, and the
 * preview panel may not be open, so this one lives hidden and starts when it is first needed.
 */
export class StripMaker {
  readonly #url: string;
  #frame: HTMLIFrameElement | undefined;
  #ready: Promise<void> | undefined;
  #nextRequest = 0;

  constructor(url: string) {
    this.#url = url;
  }

  #start(): Promise<void> {
    this.#ready ??= new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.tabIndex = -1;
      frame.hidden = true;
      frame.title = "";
      // Anything can write to this page, and reading `data` is what builds a message.
      const onReady = (event: MessageEvent<FromCompositor>) => {
        if (event.source !== frame.contentWindow || event.data.type !== "ready") return;
        removeEventListener("message", onReady);
        resolve();
      };
      addEventListener("message", onReady);
      frame.src = this.#url;
      document.body.append(frame);
      this.#frame = frame;
    });
    return this.#ready;
  }

  /** Resolves to undefined when the video cannot be read here. */
  async make(file: Blob, count: number): Promise<ImageBitmap | undefined> {
    await this.#start();
    const frame = this.#frame;
    this.#nextRequest += 1;
    const request = this.#nextRequest;
    return new Promise((resolve) => {
      const finish = (image: ImageBitmap | undefined) => {
        clearTimeout(timer);
        removeEventListener("message", onMessage);
        resolve(image);
      };
      const timer = setTimeout(() => finish(undefined), TIMEOUT_MS);
      const onMessage = (event: MessageEvent<FromCompositor>) => {
        if (event.source !== frame?.contentWindow) return;
        const { data } = event;
        if (data.type === "strip" && data.request === request) finish(data.image);
      };
      addEventListener("message", onMessage);
      const message: ToCompositor = {
        type: "strip",
        request,
        file,
        count,
        height: STRIP_HEIGHT,
      };
      // The sandbox has no origin of its own to name.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- see above
      frame?.contentWindow?.postMessage(message, "*");
    });
  }
}

/** For saving: a picture of this size is small as WebP. */
export async function encodeStrip(image: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext("2d")?.drawImage(image, 0, 0);
  return canvas.convertToBlob({ type: "image/webp", quality: 0.7 });
}
