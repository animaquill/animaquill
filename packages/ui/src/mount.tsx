import "./theme/tokens.css";
import type { Dropped, Host } from "@animaquill/host";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { watchPage } from "./diagnostics/errors.ts";
import { createI18n, sayLocalRepositories } from "./i18n/i18n.ts";
import { builtinPanels } from "./panels/builtin.tsx";
import type { PanelDefinition } from "./workbench/panels.ts";
import { Workbench } from "./workbench/workbench.ts";
import { layouts } from "./workbench/layouts.ts";
import { workerHasher } from "./media/hasher.ts";
import { workerProxyMaker } from "./proxy/maker.ts";

/** The keys that work while the project properties are open. */
const UNDO_ONLY: ReadonlySet<string> = new Set(["edit.undo", "edit.redo"]);

export interface EditorOptions {
  readonly host: Host;
  /** Shown in the status bar, so that a report can say which build it is about. */
  readonly version: string;
  /** The page with the compositor, on a site of its own where that is possible. */
  readonly compositorUrl: string;
  /**
   * Where scenes run, each with an origin of its own, and none where the compositor is. Without
   * them scenes show a placeholder.
   */
  readonly sceneOrigins?: readonly string[];
  /** For development: runs scenes as normal pages, without capture. */
  readonly sceneStage?: "plain";
  /** For tests: how long code gets to make a sound. */
  readonly soundLimitMs?: number;
  /** For tests: how long making a proxy waits after each frame, to see one on its way. */
  readonly proxyFrameMs?: number;
  /** For tests: how long opening a project waits for the platform, see `OpeningTiming`. */
  readonly catchUpMs?: number;
  /** For tests: what the editor waits for before it gets ready, to drop something meanwhile. */
  readonly holdLoad?: () => Promise<void>;
  /** Panels the host adds to the built-in ones. */
  readonly panels?: readonly PanelDefinition[];
  /** For tests: what no control can do yet, such as changing code. */
  readonly onWorkbench?: (workbench: Workbench) => void;
  /**
   * For tests: `false` renders without React's strict mode, as the site does in effect. In
   * development strict mode runs every effect twice, which hides what goes wrong only when it runs
   * once, such as the focus of a dialog taken away by what closes in the same commit.
   */
  readonly strict?: boolean;
}

/**
 * Said on the window once the editor takes what is dropped on the page. What runs on the page before
 * the editor can hold back drops until then, as the page of the web app does, and keep the last of
 * them where `DROPPED_EARLY` says, in the shape of `keepDropped`: the editor opens it once it is there.
 */
const EDITOR_HERE = "animaquill-editor";
const DROPPED_EARLY = "animaquillDropped";

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;

/**
 * What was dropped, asked of the `drop` event right away and kept, for when the editor is ready:
 * `LocalFolders.dropped` gives the same of it later as it would have in the event. The browser
 * lets go of what was dropped once the event is over, but not of what it was asked for.
 */
function keepDropped(transfer: DataTransfer): Dropped {
  return {
    items: Array.from(transfer.items, (item) => {
      const { kind } = item;
      const { getAsFileSystemHandle } = item as DataTransferItem & {
        getAsFileSystemHandle?: () => Promise<unknown>;
      };
      if (kind !== "file" || !getAsFileSystemHandle) return { kind };
      const handle = getAsFileSystemHandle.call(item);
      // Whoever asks later hears what went wrong.
      handle.catch(() => {});
      return { kind, getAsFileSystemHandle: () => handle };
    }),
  };
}

/**
 * Takes what is dropped on the page from now on, while the editor gets ready, and keeps the last of
 * it, also what the page kept before. A file dropped meanwhile does not replace the page, and a
 * folder is not lost: it opens once the editor is there. `take` lets go and gives what was kept.
 */
function holdDrops(): { take(): Dropped | undefined } {
  const keep = (event: DragEvent) => {
    if (carriesFiles(event)) event.preventDefault();
  };
  let last: Dropped | undefined;
  const hold = (event: DragEvent) => {
    if (!carriesFiles(event) || !event.dataTransfer) return;
    event.preventDefault();
    last = keepDropped(event.dataTransfer);
  };
  window.addEventListener("dragenter", keep);
  window.addEventListener("dragover", keep);
  window.addEventListener("drop", hold);
  // What the page held back, see `EDITOR_HERE`, which lets go of drops once it hears this.
  window.dispatchEvent(new Event(EDITOR_HERE));
  const page = window as unknown as Record<string, Dropped | undefined>;
  last = page[DROPPED_EARLY];
  delete page[DROPPED_EARLY];
  return {
    take() {
      window.removeEventListener("dragenter", keep);
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", hold);
      return last;
    },
  };
}

/** Starts the editor in an element. Returns how to remove it again. */
export async function mountEditor(element: HTMLElement, options: EditorOptions) {
  // From the first moment: people drop a folder on the page as soon as they see it.
  const held = holdDrops();
  await options.holdLoad?.();
  const i18n = await createI18n();
  const workbench = new Workbench({
    host: options.host,
    t: i18n.t,
    version: options.version,
    platform: /Mac/.test(navigator.platform) ? "mac" : "other",
    panels: [...builtinPanels, ...(options.panels ?? [])],
    layouts,
    compositorUrl: options.compositorUrl,
    sceneOrigins: options.sceneOrigins ?? [],
    ...(options.sceneStage && { sceneStage: options.sceneStage }),
    ...(options.soundLimitMs !== undefined && { soundLimitMs: options.soundLimitMs }),
    ...(options.catchUpMs !== undefined && { openingTiming: { catchUpMs: options.catchUpMs } }),
    // A large video takes a while to hash, and the page goes on meanwhile.
    hasher: workerHasher(),
    // The same for making smaller copies of large videos for the preview.
    proxyMaker: workerProxyMaker({ frameMs: options.proxyFrameMs }),
  });
  // A platform that saves every project to repositories of its own says so in every text of them.
  const account = options.host.account;
  const followAccount = () => {
    const who = account?.getSnapshot();
    if (who?.status === "signedIn" && who.repositories === "local") sayLocalRepositories(i18n);
  };
  account?.subscribe(followAccount);
  followAccount();
  // Before anything else runs, so that whatever fails from here on is caught.
  const stopWatching = watchPage(workbench.errors, workbench.diagnostics, options.compositorUrl);
  await workbench.load();
  options.onWorkbench?.(workbench);

  const root = createRoot(element);
  const app = <App workbench={workbench} i18n={i18n} />;
  root.render(options.strict === false ? app : <StrictMode>{app}</StrictMode>);
  void workbench.resume();

  // Pages can go away without warning, so hiding is the last reliable moment to save.
  const save = () => {
    if (document.visibilityState !== "hidden" && !leaving) return;
    void workbench.layout.flush();
    workbench.timeline.flush();
    workbench.keyframes.flush();
    // What is in the log is safe, and the folder should have it too, should the page not come back.
    void workbench.projectFolders?.flush();
    void workbench.chat.flush();
    // AI tasks and batches can still be taken back after a reload.
    void workbench.undo.flush();
    // The AI settings and keys of the online mode are only in this page until the backend has
    // them, and conversations wait here: they go now.
    void workbench.accountAi?.flush();
    void workbench.chatSync?.flush();
  };
  document.addEventListener("visibilitychange", save);
  // A reload or a closing tab does not always say it hid first.
  let leaving = false;
  window.addEventListener("pagehide", () => {
    leaving = true;
    save();
    leaving = false;
  });

  // People come back from their files, where they may have taken proxies away, and perhaps from
  // another tab, where they signed in or out.
  const lookAgain = () => {
    void workbench.proxies?.lookAgain();
    void workbench.account?.refresh();
  };
  window.addEventListener("focus", lookAgain);

  // A dialog has to be answered first: nothing behind it should change in the meantime. Keys
  // typed in the settings are theirs too.
  // In the project properties only undo and redo: what they change is a step like any other.
  const onKeyDown = (event: KeyboardEvent) => {
    if (workbench.dialogs.getSnapshot() || workbench.settingsNav.isOpen) return;
    if (workbench.projectNav.isOpen) workbench.keybindings.handle(event, UNDO_ONLY);
    else workbench.keybindings.handle(event);
  };
  window.addEventListener("keydown", onKeyDown);
  // Keys held down, like K for J and L, end when they come up, wherever that is.
  window.addEventListener("keyup", (event) => workbench.keybindings.handleUp(event));
  window.addEventListener("blur", () => workbench.keybindings.releaseAll());

  // A file dropped next to where it can go would replace the whole page. The browser goes by the
  // last of `dragenter` and `dragover`: when the page changes under the pointer, as the start page
  // does once its list is read, only `dragenter` comes before the drop, and without this here the
  // drop would not come at all.
  const keepFiles = (event: DragEvent) => {
    if (carriesFiles(event)) event.preventDefault();
  };
  // A folder dropped anywhere else opens as a project, where projects are folders. What a panel
  // takes, such as assets, it has taken already.
  const open = (dropped: Dropped) => {
    const { projectFolders, dialogs, notifications, t } = workbench;
    if (!projectFolders)
      notifications.push(
        t(workbench.mode === "online" ? "folder.droppedOnline" : "folder.droppedNoFolders"),
      );
    // A dialog has to be answered first, and a new one would answer it.
    else if (dialogs.getSnapshot()) notifications.push(t("folder.droppedWhileAsking"));
    else projectFolders.dropped(dropped);
  };
  const openDropped = (event: DragEvent) => {
    const transfer = event.dataTransfer;
    if (!transfer || !carriesFiles(event)) return;
    const taken = event.defaultPrevented;
    event.preventDefault();
    if (!taken) open(transfer);
  };
  window.addEventListener("dragenter", keepFiles);
  window.addEventListener("dragover", keepFiles);
  window.addEventListener("drop", openDropped);
  // In the same moment as the editor takes drops from here on.
  const early = held.take();
  if (early) open(early);

  // Leaving now would lose work, which the browser can still ask about.
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    // It goes on purpose, with everything kept or people having said so, see `leavePage`.
    if (workbench.leavingPage) return;
    const { code, session, transfer, trials, videos, saveToFolders } = workbench;
    // An export that stops halfway can go on after a reload, but its sound has to catch up first.
    const exporting = videos.getSnapshot() !== undefined;
    // A copy on its way into a folder would be half of one.
    const moving = saveToFolders?.busy === true;
    // Files of assets on their way stop, and go on once the project is open again: people are
    // asked, as they are when they close it.
    const atRisk =
      session.hasUnsavedChanges ||
      transfer.running ||
      trials.notKept ||
      exporting ||
      moving ||
      workbench.uploading ||
      // Changes of the AI settings or keys that the backend does not have: nowhere else.
      workbench.accountAi?.hasUnsent === true;
    if (atRisk || code.hasUnsaved) event.preventDefault();
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    window.removeEventListener("drop", openDropped);
    window.removeEventListener("dragover", keepFiles);
    window.removeEventListener("dragenter", keepFiles);
    window.removeEventListener("beforeunload", onBeforeUnload);
    window.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("visibilitychange", save);
    window.removeEventListener("focus", lookAgain);
    workbench.proxies?.dispose();
    root.unmount();
    stopWatching();
  };
}
