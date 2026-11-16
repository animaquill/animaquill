import { buildRenderPlan, type ProjectState, type RenderPlan } from "@animaquill/core";
import type { ChatImageStore } from "@animaquill/host";
import { StillFailed, type LookResult, type LookSpec, type StillFailure } from "@animaquill/render";
import {
  LOOK_SIDES,
  type LookAnswer,
  type LookFailure,
  type LookRequest,
  type LookSize,
  type LookedShot,
} from "@animaquill/tools";
import { Emitter } from "../workbench/emitter.ts";

/**
 * The frames AI looks at in the browser (mcp.md 8, rendering.md 4): rendered as the export renders
 * them, in compositors of their own that nobody sees, so that the preview stays where it is. AI
 * gives way to people: while they play (where the settings say so) or export, it waits, and while
 * the page is in the background, where the browser draws nothing, it waits too and says so. What is
 * drawn on the pictures and what differs between two is worked out in the compositor; only encoded
 * pictures come out of it, and those are kept where the pictures of conversations are.
 */

/** What looking at frames is doing now, for the line over the input of the chat. */
export type LookPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "rendering"; readonly done: number; readonly total: number }
  /** People play, or export: AI waits for them. */
  | { readonly kind: "playing" }
  | { readonly kind: "exporting" }
  /** The page is in the background, where the browser draws nothing. */
  | { readonly kind: "hidden" };

/** What renders a look: a compositor of a project in one state, as an export has one. */
export interface LookCompositor {
  look(spec: LookSpec): Promise<LookResult>;
  dispose(): void;
}

export interface FrameLooksOptions {
  /** A compositor of its own, for the project as it is in `state`, drawing `plan`. */
  readonly compositor: (state: ProjectState, plan: RenderPlan) => LookCompositor;
  readonly images: ChatImageStore;
  /** What people do with the computer now, which AI gives way to. */
  readonly busy: () => "playing" | "exporting" | undefined;
  /** Whether AI waits while people play, as the settings say. */
  readonly waitsForPlayback: () => boolean;
  /** How large pictures are where AI does not say, as the settings say. */
  readonly size: () => LookSize;
  readonly hidden: () => boolean;
  /** Listens to what `busy` and `hidden` say; resolves to stop listening. */
  readonly watch: (changed: () => void) => () => void;
  /** Tells people, once a look waits for the page to come back, where they allowed notifications. */
  readonly notify?: () => void;
}

/** The plan of a timeline as AI wants it: at a size, or only a part of the picture, larger. */
export function lookPlan(
  base: RenderPlan,
  side: number,
  region?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  cells?: { readonly count: number; readonly columns: number },
): RenderPlan {
  if (region) {
    const across = region.width >= region.height;
    const width = Math.max(1, Math.round(across ? side : (side * region.width) / region.height));
    const height = Math.max(1, Math.round(across ? (side * region.height) / region.width : side));
    // Pixels for a unit of the world are zoom × the short side / 1080, see `viewMatrix`.
    const zoom = (width / region.width) * (1080 / Math.min(width, height));
    return {
      ...base,
      width,
      height,
      camera: {
        "camera.x": { kind: "still", value: region.x + region.width / 2 },
        "camera.y": { kind: "still", value: region.y + region.height / 2 },
        "camera.zoom": { kind: "still", value: zoom },
      },
    };
  }
  const columns = cells ? Math.max(1, Math.min(cells.columns, cells.count)) : 1;
  const rows = cells ? Math.ceil(cells.count / columns) : 1;
  const scale = side / Math.max(base.width * columns, base.height * rows);
  return {
    ...base,
    width: Math.max(1, Math.round(base.width * scale)),
    height: Math.max(1, Math.round(base.height * scale)),
  };
}

/** Why a picture has nothing, in the words of the tools. */
function failureOf(error: unknown): LookFailure {
  if (!(error instanceof StillFailed)) {
    if (error instanceof DOMException && error.name === "AbortError") return { reason: "stopped" };
    return { reason: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  const { failure } = error;
  switch (failure.reason) {
    case "scene":
      return {
        reason: "scene",
        layer: failure.layer,
        state: failure.status.state,
        ...(failure.status.message !== undefined && { message: failure.status.message }),
      };
    default:
      return failure;
  }
}

/** A moment before and after a change, for people to look at, see `FrameLooks.pictures`. */
export interface PicturesRequest {
  readonly before: ProjectState;
  readonly after: ProjectState;
  readonly timeline: string;
  readonly seconds: number;
  /** Of the long side, in pixels. */
  readonly side: number;
}

/** One of the two pictures, or why it could not be rendered. */
export type PictureSide =
  | { readonly ok: true; readonly image: Blob; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly failure: StillFailure };

export interface PicturesAnswer {
  readonly before: PictureSide;
  readonly after: PictureSide;
}

class Stopped extends Error {
  constructor() {
    super("The task stopped");
  }
}

export class FrameLooks {
  readonly #options: FrameLooksOptions;
  readonly #emitter = new Emitter();
  #phase: LookPhase = { kind: "idle" };
  /** One look at a time: the next waits for the one before. */
  #queue: Promise<unknown> = Promise.resolve();
  #notified = false;

  constructor(options: FrameLooksOptions) {
    this.#options = options;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): LookPhase => this.#phase;

  #set(phase: LookPhase): void {
    this.#phase = phase;
    this.#emitter.emit();
  }

  /** Renders what AI asked for, see `LookRequest`, unless `signal` stops it first. */
  look(request: LookRequest, sees: boolean, signal?: AbortSignal): Promise<LookAnswer> {
    const run = this.#queue.then(() => this.#look(request, sees, signal));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * One moment of two states of a project, the way `look` renders them, for people who look at what
   * a change did: nothing is kept, and it is nobody's task, so it neither says that AI looks nor
   * waits for people. It still waits for whatever AI looks at, one look at a time.
   */
  pictures(request: PicturesRequest): Promise<PicturesAnswer> {
    const run = this.#queue.then(() => this.#pictures(request));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #pictures({
    before,
    after,
    timeline,
    seconds,
    side,
  }: PicturesRequest): Promise<PicturesAnswer> {
    const now = buildRenderPlan(after, timeline);
    const was = buildRenderPlan(before, timeline);
    // Both at the size of the picture after, each on its own: one can fail and the other not.
    const size = lookPlan(now ?? was ?? ({ width: side, height: side } as RenderPlan), side);
    const render = async (
      state: ProjectState,
      plan: RenderPlan | undefined,
    ): Promise<PictureSide> => {
      if (!plan) {
        return { ok: false, failure: { reason: "failed", message: "No such timeline" } };
      }
      let compositor: LookCompositor | undefined;
      try {
        compositor = this.#options.compositor(state, {
          ...plan,
          width: size.width,
          height: size.height,
        });
        const result = await compositor.look({
          cells: [{ seconds, marks: [] }],
          columns: 1,
          texts: false,
        });
        return { ok: true, image: result.image, width: result.width, height: result.height };
      } catch (error) {
        const failure: StillFailure =
          error instanceof StillFailed
            ? error.failure
            : {
                reason: "failed",
                message: error instanceof Error ? error.message : String(error),
              };
        return { ok: false, failure };
      } finally {
        compositor?.dispose();
      }
    };
    return { before: await render(before, was), after: await render(after, now) };
  }

  /**
   * Until people stop playing or exporting, as far as AI gives way to that, and the page shows.
   * Each of those waits says so, and the page in the background tells people once.
   */
  async #free(signal: AbortSignal | undefined): Promise<void> {
    const { busy, waitsForPlayback, hidden, watch } = this.#options;
    const blocked = (): LookPhase | undefined => {
      const doing = busy();
      if (doing === "exporting") return { kind: "exporting" };
      if (doing === "playing" && waitsForPlayback()) return { kind: "playing" };
      return hidden() ? { kind: "hidden" } : undefined;
    };
    for (let now = blocked(); now; now = blocked()) {
      if (signal?.aborted) throw new Stopped();
      if (now.kind === "hidden" && !this.#notified) {
        this.#notified = true;
        this.#options.notify?.();
      }
      if (this.#phase.kind !== now.kind) this.#set(now);
      await new Promise<void>((done) => {
        const stop = watch(() => {
          stop();
          signal?.removeEventListener("abort", onAbort);
          done();
        });
        const onAbort = () => {
          stop();
          done();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (signal?.aborted) throw new Stopped();
  }

  async #look(
    request: LookRequest,
    sees: boolean,
    signal: AbortSignal | undefined,
  ): Promise<LookAnswer> {
    const side = LOOK_SIDES[request.size ?? this.#options.size()];
    const version = request.format === undefined ? undefined : { format: request.format };
    const now = buildRenderPlan(request.state, request.timeline, version);
    const was = request.before && buildRenderPlan(request.before, request.timeline, version);
    if (!now || (request.before && !was)) {
      return { ok: false, shot: 0, failure: { reason: "failed", message: "No such timeline" } };
    }
    const sheet = request.kind === "sheet";
    const cells = sheet
      ? { count: request.shots.length, columns: request.columns ?? 4 }
      : undefined;
    const plan = lookPlan(now, side, request.region, cells);
    // The plan as it was, at the same size and from the same place, to compare pixel by pixel.
    const before = was && { ...was, width: plan.width, height: plan.height, camera: plan.camera };
    const total = (sheet ? 1 : request.shots.length) * (before ? 2 : 1);
    let done = 0;
    let shot = 0;
    let isBefore = false;
    const compositors: LookCompositor[] = [];
    this.#notified = false;
    try {
      await this.#free(signal);
      this.#set({ kind: "rendering", done, total });
      const after = this.#options.compositor(request.state, plan);
      compositors.push(after);
      const earlier = before && request.before && this.#options.compositor(request.before, before);
      if (earlier) compositors.push(earlier);
      const stop = () => {
        for (const compositor of compositors) compositor.dispose();
      };
      signal?.addEventListener("abort", stop, { once: true });
      const step = async <T>(work: () => Promise<T>): Promise<T> => {
        await this.#free(signal);
        this.#set({ kind: "rendering", done, total });
        const result = await work();
        done += 1;
        this.#set({ kind: "rendering", done, total });
        return result;
      };
      const keep = async (blob: Blob | undefined, width: number, height: number) =>
        sees && blob ? this.#options.images.save(blob, { width, height }) : undefined;
      const shots: LookedShot[] = [];
      let width = plan.width;
      let height = plan.height;
      const groups = sheet
        ? [
            request.shots.map((each) => ({
              seconds: each.seconds,
              label: each.label,
              marks: each.marks,
            })),
          ]
        : request.shots.map((each) => [{ seconds: each.seconds, marks: each.marks }]);
      try {
        for (const [index, group] of groups.entries()) {
          shot = index;
          let base: LookResult | undefined;
          if (earlier) {
            isBefore = true;
            base = await step(() =>
              earlier.look({
                cells: group.map(({ seconds }) => ({ seconds, marks: [] })),
                columns: 1,
                texts: false,
                lossless: true,
              }),
            );
            isBefore = false;
          }
          const marked = group.some(({ marks }) => marks.length > 0);
          const result = await step(() =>
            after.look({
              cells: group,
              columns: cells?.columns ?? 1,
              texts: request.texts,
              ...(marked && { clean: true }),
              ...(base?.lossless && { base: base.lossless }),
            }),
          );
          ({ width, height } = result);
          const picture = await keep(result.image, width, height);
          const clean = marked ? await keep(result.clean, width, height) : undefined;
          const old = await keep(base?.image, width, height);
          const diff = await keep(result.diff?.image, width, height);
          shots.push({
            ...(picture && { picture }),
            ...(clean && { clean }),
            ...(old && { before: old }),
            ...(diff && { diff }),
            ...(result.diff && {
              changed: {
                ratio: result.diff.ratio,
                ...(result.diff.box && { box: result.diff.box }),
              },
            }),
            texts: result.texts.map(({ layer, texts, more }) => ({
              layer,
              texts,
              ...(more && { more: true as const }),
            })),
          });
        }
      } finally {
        signal?.removeEventListener("abort", stop);
      }
      return { ok: true, sees, width, height, shots };
    } catch (error) {
      if (error instanceof Stopped || signal?.aborted)
        return { ok: false, shot, failure: { reason: "stopped" } };
      const cell = (error as { cell?: unknown }).cell;
      return {
        ok: false,
        shot: sheet && typeof cell === "number" ? cell : shot,
        ...(isBefore && { before: true as const }),
        failure: failureOf(error),
      };
    } finally {
      for (const compositor of compositors) compositor.dispose();
      this.#set({ kind: "idle" });
    }
  }
}
