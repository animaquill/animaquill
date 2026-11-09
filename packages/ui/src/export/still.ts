import {
  buildRenderPlan,
  entryOf,
  showsAt,
  transitionsNotDone,
  type ProjectState,
} from "@animaquill/core";
import type { FolderAccess, ProjectLibrary } from "@animaquill/host";
import { failureOf, StillFailed } from "@animaquill/render";
import type { TFunction } from "i18next";
import type { PreviewStatus } from "../preview/status.ts";
import type { TimelineEditor } from "../timeline/editor.ts";
import type { Dialogs } from "../workbench/dialogs.ts";
import type { Notifications } from "../workbench/notifications.ts";
import { projectKeyOf, type ProjectSession } from "../workbench/session.ts";
import {
  ExportCompositor,
  exportCompositorOptions,
  type ExportCompositorOptions,
} from "./compositor.ts";
import { describeFailure, notDoneFailure, type ExportFailure } from "./words.ts";

export interface StillExportOptions {
  readonly session: ProjectSession;
  readonly timeline: TimelineEditor;
  readonly projects: ProjectLibrary;
  readonly folders: FolderAccess;
  readonly preview: PreviewStatus;
  readonly dialogs: Dialogs;
  readonly notifications: Notifications;
  readonly t: TFunction;
  readonly compositorUrl: string;
  readonly sceneOrigins: readonly string[];
  readonly sceneStage: "plain" | undefined;
  /** For tests. */
  readonly compositor?: (options: ExportCompositorOptions) => StillCompositor;
  readonly encode?: (image: ImageBitmap) => Promise<Blob>;
}

export type StillCompositor = Pick<ExportCompositor, "still" | "dispose">;

/** A picture to a file, the way it is: PNG has no loss, and nothing has to read the pixels here. */
export async function encodeStill(image: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const painter = canvas.getContext("bitmaprenderer");
  if (!painter) throw new Error("No bitmap context");
  painter.transferFromImageBitmap(image);
  return canvas.convertToBlob({ type: "image/png" });
}

/** Ends as soon as people ask for it. What it was waiting for gets stopped by whoever called this. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    work.then(resolve, reject);
  });
}

/**
 * The saved project at the playhead, as a file. There are two ways this ends: a picture with all of
 * it in there, or no picture and what is in the way. Something that only looks finished is the worst
 * thing an export can do, because nobody looks at it again before it goes out.
 */
export class StillExport {
  readonly #options: StillExportOptions;

  constructor(options: StillExportOptions) {
    this.#options = options;
  }

  async run(): Promise<void> {
    const { session, timeline, dialogs, notifications, t } = this.#options;
    const { store } = session;
    const { model, frame } = timeline;
    if (!store || !model) return;
    const state = store.getState();
    const plan = buildRenderPlan(state, model.id);
    if (!plan) return;
    const seconds = frame / model.rate.fps;
    // A picture is no sound: only what shows otherwise than the project says stops it.
    const shown = entryOf(state.timelines, model.id);
    const notDone = shown ? transitionsNotDone(shown, plan, undefined) : [];
    const otherwise = notDone.find((span) => showsAt(span, seconds));
    if (otherwise) {
      await this.#say(notDoneFailure(otherwise), state);
      return;
    }
    const progress = dialogs.progress({
      title: t("export.frameRunning"),
      cancel: t("dialog.cancel"),
      stopping: t("export.frameStopping"),
    });
    const { signal } = progress;
    let compositor: StillCompositor | undefined;
    let failure: unknown;
    try {
      compositor = this.#open(state, projectKeyOf(store), plan);
      const image = await untilAborted(compositor.still(seconds), signal);
      const file = await (this.#options.encode ?? encodeStill)(image);
      signal.throwIfAborted();
      const name = t("export.frameFile", {
        name: state.manifest.name,
        frame,
        interpolation: { escapeValue: false },
      });
      this.#options.folders.saveFile(file, name);
      notifications.push(
        t("export.frameDone", { file: name, interpolation: { escapeValue: false } }),
      );
    } catch (error) {
      failure = error;
    } finally {
      compositor?.dispose();
      progress.close();
    }
    if (signal.aborted) notifications.push(t("export.frameCancelled"));
    else if (failure !== undefined) await this.#tell(failure, state);
  }

  #open(
    state: ProjectState,
    project: string,
    plan: ExportCompositorOptions["plan"],
  ): StillCompositor {
    const options = exportCompositorOptions(this.#options, state, project, plan);
    return this.#options.compositor?.(options) ?? new ExportCompositor(options);
  }

  async #tell(error: unknown, state: ProjectState): Promise<void> {
    if (!(error instanceof StillFailed)) console.warn("No still", error);
    await this.#say(failureOf(error), state);
  }

  async #say(failure: ExportFailure, state: ProjectState): Promise<void> {
    const { dialogs, t } = this.#options;
    await dialogs.confirm({
      title: t("export.frameFailed"),
      message: describeFailure(t, failure, state, this.#options.timeline),
      confirm: t("dialog.close"),
      noticeOnly: true,
    });
  }
}
