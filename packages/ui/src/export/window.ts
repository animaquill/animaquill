import type { TFunction } from "i18next";

/** Where the compositor of an export runs: a window of its own, or this page. */
export interface ExportWindow {
  readonly kind: "window" | "page";
  readonly document: Document;
  /** Resolves when people closed it. This page never closes under an export. */
  readonly closed: Promise<void>;
  close(): void;
}

/** How windows for exports come about. */
export interface ExportWindows {
  /** Whether this browser has them at all. */
  readonly supported: boolean;
  /** Whether one can open now, without people pressing a button for it first. */
  canOpenNow(): boolean;
  /** Has to run right after people did something. Undefined when the browser said no. */
  open(): Promise<ExportWindow | undefined>;
}

/** What an export looks like in its window, kept up to date until the window goes. */
export type FillWindow = (page: Document) => () => void;

interface PictureInPicture {
  requestWindow(options: { width: number; height: number }): Promise<Window>;
}

const WIDTH = 380;
const HEIGHT = 230;

/** This page, for a browser without windows of their own, or for people who want it here. */
export const thisPage = (): ExportWindow => ({
  kind: "page",
  document,
  closed: new Promise(() => {}),
  close: () => {},
});

/**
 * Document Picture-in-Picture: a small window that stays on top of everything. What is in it gets
 * drawn whatever happens to the page it came from, so an export goes on while people work in
 * another tab. A browser only opens one when people just pressed something.
 */
export function pictureInPictureWindows(fill: FillWindow): ExportWindows {
  const api = (globalThis as { documentPictureInPicture?: PictureInPicture })
    .documentPictureInPicture;
  return {
    supported: api !== undefined,
    canOpenNow: () =>
      (globalThis as { navigator?: Navigator }).navigator?.userActivation?.isActive === true,
    async open() {
      if (!api) return undefined;
      let opened: Window;
      try {
        opened = await api.requestWindow({ width: WIDTH, height: HEIGHT });
      } catch (error) {
        console.warn("No window for the export", error);
        return undefined;
      }
      const page = opened.document;
      // The same look as here: the colors are variables of the editor.
      for (const sheet of document.querySelectorAll('style, link[rel="stylesheet"]')) {
        page.head.append(sheet.cloneNode(true));
      }
      page.documentElement.lang = document.documentElement.lang;
      const stop = fill(page);
      const closed = new Promise<void>((resolve) => {
        opened.addEventListener(
          "pagehide",
          () => {
            stop();
            resolve();
          },
          { once: true },
        );
      });
      return { kind: "window", document: page, closed, close: () => opened.close() };
    },
  };
}

/** What the window shows of an export. */
export interface WindowView {
  readonly name: string;
  readonly done: number;
  readonly total: number;
  readonly remainingMs?: number;
  readonly stopping: boolean;
  readonly catchingUp?: number;
  readonly writing?: boolean;
  readonly makingSound?: boolean;
  readonly readingMedia?: boolean;
  readonly pausing?: boolean;
  /** Exports in line behind this one, which go on in this window. */
  readonly after?: number;
}

/** Minutes and seconds, which is as exact as an estimate gets. */
export function duration(ms: number): string {
  const seconds = Math.max(Math.round(ms / 1000), 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Styles go on the elements: the policy of the editor takes no style sheets of its own. */
const look = (element: HTMLElement, style: Partial<CSSStyleDeclaration>) =>
  Object.assign(element.style, style);

/**
 * The few things there are to see in the window: what goes on, how far it is, and how to stop it.
 * Plain DOM, because this document has nothing of the editor in it.
 */
export function fillExportWindow(
  page: Document,
  t: TFunction,
  watch: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): WindowView | undefined;
  },
  cancel: () => void,
  pause?: () => void,
): () => void {
  page.title = t("export.window.title");
  look(page.body, {
    margin: "0",
    padding: "14px 16px",
    color: "var(--aq-text, #ddd)",
    background: "var(--aq-bg-menu, #1f1f23)",
    font: "13px system-ui, sans-serif",
  });
  const heading = page.createElement("h1");
  const file = page.createElement("p");
  const bar = page.createElement("progress");
  const amount = page.createElement("p");
  amount.setAttribute("role", "status");
  const note = page.createElement("p");
  note.textContent = t("export.window.note");
  const after = page.createElement("p");
  const buttons = page.createElement("div");
  const stop = page.createElement("button");
  stop.type = "button";
  stop.textContent = t("export.video.cancel");
  stop.addEventListener("click", cancel);
  const hold = page.createElement("button");
  hold.type = "button";
  hold.textContent = t("export.window.pause");
  if (pause) hold.addEventListener("click", pause);
  look(heading, {
    margin: "0 0 4px",
    fontSize: "14px",
    fontWeight: "600",
    color: "var(--aq-text-strong, #fff)",
  });
  for (const text of [file, amount, after, note]) {
    look(text, {
      margin: "0 0 8px",
      color: "var(--aq-text-muted, #aaa)",
      overflowWrap: "anywhere",
    });
  }
  look(bar, { display: "block", width: "100%", height: "6px", margin: "4px 0 8px" });
  look(buttons, { display: "flex", gap: "8px" });
  for (const button of [stop, hold]) {
    look(button, {
      padding: "4px 14px",
      color: "inherit",
      font: "inherit",
      background: "var(--aq-bg-input, #333)",
      border: "1px solid var(--aq-border, #444)",
      borderRadius: "3px",
      cursor: "pointer",
    });
  }
  // Cancelling comes first, where it always was: people who know the window press it there.
  buttons.append(stop, ...(pause ? [hold] : []));
  page.body.append(heading, file, bar, amount, after, note, buttons);

  const show = () => {
    const job = watch.getSnapshot();
    if (!job) return;
    const { name, done, total, remainingMs, stopping, catchingUp, writing, makingSound } = job;
    const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
    heading.textContent = stopping
      ? t("export.video.stopping")
      : writing
        ? t("export.video.writing")
        : job.pausing
          ? t("export.queue.status.pausing")
          : makingSound
            ? t("export.video.makingSound")
            : catchingUp !== undefined
              ? t("export.resume.catchingUp", { percent: Math.floor(catchingUp * 100) })
              : job.readingMedia
                ? t("export.queue.status.readingMedia")
                : t("export.video.running", { percent });
    file.textContent = name;
    bar.max = Math.max(total, 1);
    bar.value = done;
    amount.textContent =
      t("export.window.frames", { done, total }) +
      (remainingMs === undefined
        ? ""
        : ` · ${t("export.video.remaining", { time: duration(remainingMs) })}`);
    stop.disabled = stopping;
    hold.disabled = stopping || job.writing === true || job.pausing === true;
    after.textContent = job.after ? t("export.window.after", { count: job.after }) : "";
    after.hidden = !job.after;
  };
  show();
  return watch.subscribe(show);
}
