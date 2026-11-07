import type { ProjectState, RenderPlan } from "@animaquill/core";
import type { ProjectLibrary } from "@animaquill/host";
import {
  SCENE_CORNER,
  StillFailed,
  type EncodedChunk,
  type FrameToEncode,
  type FromCompositor,
  type SceneSetup,
  type ToCompositor,
} from "@animaquill/render";
import { sceneContent } from "../preview/content.ts";
import { ForeignMessages } from "../preview/foreign.ts";
import { KeyboardKeeper } from "../preview/keyboard.ts";
import type { PreviewStatus } from "../preview/status.ts";
import { CompositorWatch } from "../preview/watch.ts";

export interface ExportCompositorOptions {
  readonly url: string;
  /** What it runs in. It stays out of the way, but it has to be somewhere that is on the screen. */
  readonly document: Document;
  readonly setup: SceneSetup;
  /** What is saved. What somebody is only trying out does not leave the preview. */
  readonly plan: RenderPlan;
  /** What the plan was made from. It does not follow the project: an export is of one moment. */
  readonly state: ProjectState;
  /** Resolves to undefined when the file is not there. */
  readonly media: (hash: string) => Promise<Blob | undefined>;
  /** Scenes must stay away from there, also in the preview. */
  readonly onRetired?: (origin: string) => void;
}

interface Pending {
  readonly done: (answer: ImageBitmap | undefined) => void;
  readonly failed: (reason: unknown) => void;
}

/** What gets asked and answered by request. */
type Request =
  | { readonly type: "still"; readonly seconds: number }
  | { readonly type: "encode-start"; readonly config: VideoEncoderConfig }
  | ({ readonly type: "encode-frame" } & FrameToEncode)
  | { readonly type: "encode-end" }
  | { readonly type: "encode-flush" };

const stoppedAnswering = () => new StillFailed({ reason: "compositor" });

/** The window the compositor was in has been closed, and it went with it. */
export class WindowClosed extends Error {
  constructor() {
    super("The window of the export was closed");
  }
}

/**
 * Bytes of this page. What comes from a window of its own is made there, and fails `instanceof`
 * here, which is what libraries check: Mediabunny would not take it.
 */
const ownBytes = (bytes: AllowSharedBufferSource): Uint8Array<ArrayBuffer> =>
  ArrayBuffer.isView(bytes)
    ? new Uint8Array(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    : new Uint8Array(new Uint8Array(bytes));

/** A chunk as if it had been made on this page. */
function ownChunk(chunk: EncodedChunk): EncodedChunk {
  const { data, key, timestamp, duration, decoderConfig } = chunk;
  const config = decoderConfig && {
    ...decoderConfig,
    ...(decoderConfig.description && { description: ownBytes(decoderConfig.description) }),
  };
  return {
    data: ownBytes(data).buffer,
    key,
    timestamp,
    duration,
    ...(config && { decoderConfig: config }),
  };
}

/**
 * A compositor of its own for an export, next to the one of the preview. That one shows whatever is
 * there by now and what people are trying out, and it goes wherever the playhead goes.
 *
 * Unlike the one for strips this one cannot be hidden: scenes only get drawn in a frame that has
 * pixels on the screen. So the corner of it where they sit stays on the screen.
 */
export class ExportCompositor {
  readonly #options: ExportCompositorOptions;
  readonly #frame: HTMLIFrameElement;
  /** Where its messages arrive: a document in a window of its own is not this page. */
  readonly #window: Window;
  readonly #foreign: ForeignMessages;
  readonly #keyboard: KeyboardKeeper;
  readonly #watch: CompositorWatch;
  readonly #ready = Promise.withResolvers<void>();
  readonly #pending = new Map<number, Pending>();
  #saidHello = false;
  #nextRequest = 0;
  /** Why it is gone, if it is. */
  #stopped: unknown;
  #onChunk: ((chunk: EncodedChunk) => void) | undefined;
  /** What the compositor said hello with, if anything. */
  #port: MessagePort | undefined;

  constructor(options: ExportCompositorOptions) {
    this.#options = options;
    const { document: mount, url } = options;
    const view = mount.defaultView;
    if (!view) throw new Error("A compositor needs a document in a window");
    this.#window = view;
    // oxlint-disable-next-line react/iframe-missing-sandbox -- the next line, and this is no React
    const frame = mount.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.tabIndex = -1;
    frame.title = "";
    Object.assign(frame.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: `${SCENE_CORNER}px`,
      height: `${SCENE_CORNER}px`,
      border: "0",
      pointerEvents: "none",
      // Under something opaque a scene crawls, see the research on scenes.
      zIndex: "2147483647",
    });
    this.#frame = frame;
    this.#foreign = new ForeignMessages(
      () => frame.contentWindow,
      (index, frames) => this.#send({ type: "evict", index, frames }),
    );
    this.#keyboard = new KeyboardKeeper(
      frame,
      (request) => this.#send({ type: "focus-taken", request }),
      mount,
    );
    this.#watch = new CompositorWatch(
      (nonce) => this.#send({ type: "ping", nonce }),
      () => this.#stop(stoppedAnswering()),
      undefined,
      () => mount,
    );
    // A window of its own goes away with everything in it when people close it.
    view.addEventListener("pagehide", this.#onGone);
    // Nobody is waiting yet when it stops answering while it starts.
    this.#ready.promise.catch(() => {});
    // It says hello once it has loaded, so this has to listen first.
    view.addEventListener("message", this.#onMessage);
    frame.src = url;
    mount.body.append(frame);
  }

  /**
   * A picture of a moment with everything in it, at the size of the output. Rejects with
   * `StillFailed` when that cannot be had. The picture belongs to whoever gets it.
   */
  async still(seconds: number): Promise<ImageBitmap> {
    return (await this.#ask({ type: "still", seconds })) as ImageBitmap;
  }

  /**
   * Starts the encoder of an export. What comes out of it goes to `onChunk`, in the order to decode
   * it in, and all of it before `finishEncoding` is over.
   */
  async startEncoding(
    config: VideoEncoderConfig,
    onChunk: (chunk: EncodedChunk) => void,
  ): Promise<void> {
    this.#onChunk = onChunk;
    await this.#ask({ type: "encode-start", config });
  }

  /** Over once the frame is in the encoder. Rejects like `still` when there is no picture. */
  async encodeFrame(frame: FrameToEncode): Promise<void> {
    await this.#ask({ type: "encode-frame", ...frame });
  }

  async finishEncoding(): Promise<void> {
    await this.#ask({ type: "encode-end" });
  }

  /** Over once all frames so far came out of the encoder, which goes on after that. */
  async flushEncoding(): Promise<void> {
    await this.#ask({ type: "encode-flush" });
  }

  async #ask(question: Request): Promise<ImageBitmap | undefined> {
    await this.#ready.promise;
    if (this.#stopped !== undefined) throw this.#stopped;
    this.#nextRequest += 1;
    const request = this.#nextRequest;
    return new Promise((done, failed) => {
      this.#pending.set(request, { done, failed });
      this.#send({ ...question, request } as ToCompositor);
    });
  }

  /** Whatever it was doing ends with it, and so do the scenes in it. */
  dispose(): void {
    this.#stop(new DOMException("Export stopped", "AbortError"));
  }

  #onGone = (): void => {
    this.#stop(new WindowClosed());
  };

  #stop(reason: unknown): void {
    this.#stopped ??= reason;
    this.#window.removeEventListener("pagehide", this.#onGone);
    this.#onChunk = undefined;
    this.#watch.dispose();
    this.#keyboard.dispose();
    this.#window.removeEventListener("message", this.#onMessage);
    this.#frame.remove();
    this.#port?.close();
    this.#ready.reject(reason);
    for (const { failed } of this.#pending.values()) failed(reason);
    this.#pending.clear();
  }

  #send(message: ToCompositor): void {
    if (this.#port) {
      // A port goes to whoever has the other end, and has no origin to name.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- see above
      this.#port.postMessage(message);
      return;
    }
    // The sandbox has no origin of its own to name.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- see above
    this.#frame.contentWindow?.postMessage(message, "*");
  }

  /** Reading `data` is what builds a message, so that only happens for what comes from the frame. */
  #onMessage = (event: MessageEvent<FromCompositor>): void => {
    const { source } = event;
    if (source !== this.#frame.contentWindow) {
      this.#foreign.note(source);
      return;
    }
    const { data } = event;
    if (data.type === "ready") {
      // Written from this page, a message to a frame in a window of its own does not come from
      // that window, and the compositor would not take it. A port does not say where it is from.
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- not every message has them
      this.#port = event.ports?.[0];
      this.#hello();
    } else if (data.type === "pong") this.#watch.pong(data.nonce);
    else if (data.type === "focus-checked") this.#keyboard.checked(data.request);
    else if (data.type === "needs") void this.#sendFile(data.id);
    else if (data.type === "needs-scene") void this.#sendScene(data.scene, data.revision);
    else if (data.type === "origin-retired") this.#options.onRetired?.(data.origin);
    else if (data.type === "still") this.#answer(data);
    else if (data.type === "encode-answer") this.#answerEncoding(data);
    else if (data.type === "encoded") this.#onChunk?.(ownChunk(data));
  };

  #answerEncoding({ request, failure }: Extract<FromCompositor, { type: "encode-answer" }>) {
    const pending = this.#pending.get(request);
    this.#pending.delete(request);
    if (failure) pending?.failed(new StillFailed(failure));
    else pending?.done(undefined);
  }

  /** A page that loads for a second time knows nothing, and an export cannot start over by itself. */
  #hello(): void {
    if (this.#saidHello) {
      this.#stop(stoppedAnswering());
      return;
    }
    this.#saidHello = true;
    this.#watch.ready();
    const { setup, plan } = this.#options;
    this.#send({ type: "exporting" });
    this.#send({ type: "setup", ...setup });
    this.#send({ type: "plan", plan });
    this.#ready.resolve();
  }

  #answer(answer: Extract<FromCompositor, { type: "still" }>): void {
    const pending = this.#pending.get(answer.request);
    this.#pending.delete(answer.request);
    if ("image" in answer) {
      if (pending) pending.done(answer.image);
      else answer.image.close();
    } else pending?.failed(new StillFailed(answer.failure));
  }

  /** The sandbox runs code from projects, so it only gets what the plan uses. */
  async #sendFile(id: string): Promise<void> {
    const { plan, media } = this.#options;
    const used = plan.layers.some(
      ({ source }) => (source.kind === "image" || source.kind === "video") && source.file === id,
    );
    const file = used ? await media(id).catch(() => undefined) : undefined;
    this.#send(file ? { type: "file", id, file } : { type: "no-file", id });
  }

  async #sendScene(scene: string, revision: string): Promise<void> {
    const { state, plan, media } = this.#options;
    const content = await sceneContent(state, plan, { scene, revision }, media);
    if (content) this.#send(content);
  }
}

/** Where an export compositor runs from and what it has to know about scenes. */
export interface ExportSite {
  readonly projects: ProjectLibrary;
  readonly preview: PreviewStatus;
  readonly compositorUrl: string;
  readonly sceneOrigins: readonly string[];
  readonly sceneStage: "plain" | undefined;
}

/** What a compositor of an export starts with, for a project in one state. */
export function exportCompositorOptions(
  { projects, preview, compositorUrl, sceneOrigins, sceneStage }: ExportSite,
  state: ProjectState,
  plan: RenderPlan,
): ExportCompositorOptions {
  const media = projects.media(state.manifest.id);
  const { runScenes } = preview.getSnapshot();
  const setup: SceneSetup = {
    // The preview starts at the other end: scenes on one origin hang together.
    origins: sceneOrigins.toReversed(),
    retired: preview.retiredOrigins,
    compositor: new URL(compositorUrl, document.baseURI).origin,
    run: runScenes,
    ...(sceneStage && { stage: sceneStage }),
  };
  return {
    // A window of its own has no address to go from.
    url: new URL(compositorUrl, document.baseURI).href,
    document,
    setup,
    plan,
    state,
    media: (hash) => media.get(hash),
    onRetired: (origin) => preview.noteRetired(origin),
  };
}
