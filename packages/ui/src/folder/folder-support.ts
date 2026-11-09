/**
 * What the tests of the folder session share: a browser in memory with its disk, its database of
 * project logs, and windows that open a project folder the way the editor does.
 */
import { ProjectStore, readFolder, type CommandCall } from "@animaquill/core";
import type {
  FolderBases,
  FolderWriter,
  LocalFolder,
  LocalFolders,
  ProjectLibrary,
  ProjectLog,
} from "@animaquill/host";
import { MemoryDisk, memoryFolders, type MemoryDiskOptions } from "@animaquill/host/memory";
import { vi } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { MemoryLibrary, memoryAddress } from "../workbench/memory-library.ts";
import { ProjectSession, type SessionMessages } from "../workbench/session.ts";
import { FolderSession, type FolderMerge, type FolderTiming } from "./session.ts";

export const PROJECT = "文档/原子";
/** The number the browser knows the folder by. */
export const LOCAL = "本机1";
export const MAIN = "timelines/main/timeline.json";
export const CODE = "code/animate.js";
export const NOTES = "notes.json";

const MESSAGES: SessionMessages = {
  createFailed() {},
  notFound() {},
  openFailed() {},
  tooNew() {},
  damaged() {},
  saveFailed() {},
  saveRecovered() {},
};

/** The example project without its locked tag, so that it can be changed. */
export function fixture(): Map<string, string> {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest, null, 2));
  return files;
}

/** Puts a project on the disk, as somebody who copied it there. */
export function putProject(disk: MemoryDisk, files = fixture(), root = PROJECT): void {
  for (const [path, text] of files) disk.write(`${root}/${path}`, text, { quietly: true });
}

/** Everything in a folder of the disk, also what belongs to tools, by its path in the folder. */
export function filesOf(disk: MemoryDisk, root = PROJECT): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (folder: string) => {
    for (const name of disk.names(folder)) {
      const path = `${folder}/${name}`;
      let isFolder = true;
      try {
        disk.names(path);
      } catch {
        isFolder = false;
      }
      if (isFolder) walk(path);
      else found.set(path.slice(root.length + 1), disk.text(path));
    }
  };
  walk(root);
  return found;
}

/** What was kept in .animaquill/recovered, by the path the file had in the project. */
export function recovered(disk: MemoryDisk, root = PROJECT): Map<string, string[]> {
  const kept = new Map<string, string[]>();
  for (const [path, text] of filesOf(disk, root)) {
    const [, original] = /^\.animaquill\/recovered\/[^/]+\/(.+)$/.exec(path) ?? [];
    if (original !== undefined) kept.set(original, [...(kept.get(original) ?? []), text]);
  }
  return kept;
}

/** Edits a document on the disk, as another program does, written the way people like. */
export function editOnDisk(
  disk: MemoryDisk,
  path: string,
  edit: (document: any) => void,
  options?: { readonly quietly?: boolean; readonly keepTime?: boolean },
): void {
  const document = JSON.parse(disk.text(`${PROJECT}/${path}`));
  edit(document);
  disk.write(`${PROJECT}/${path}`, `${JSON.stringify(document, null, 4)}\n`, options);
}

export const textOn = (disk: MemoryDisk, path: string): string => disk.text(`${PROJECT}/${path}`);

export const clipIn = (document: any, id: string): any =>
  document.tracks.flatMap((track: any) => track.clips).find((clip: any) => clip.id === id);

export function run(store: ProjectStore, type: string, params: unknown): void {
  const result = store.execute({ type, params } as CommandCall);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
}

export const renameClip = (store: ProjectStore, clip: string, name: string): void =>
  run(store, "clip.update", { timeline: "main", clip, changes: { name } });

export const clipName = (store: ProjectStore, clip: string): string | undefined =>
  store.getState().timelines["main"]?.clips[clip]?.name;

/** One window of the browser, on the project. */
export interface TestWindow {
  readonly folders: LocalFolders;
  readonly folder: LocalFolder;
  readonly project: ProjectSession;
  readonly store: ProjectStore;
  readonly session: FolderSession;
  readonly merges: FolderMerge[];
  /** The page went away with its browser: nothing it does reaches anything any more. */
  dead: boolean;
  /** What other windows wrote, held back while `holding`, see `pageLibrary`. */
  readonly arriving: { readonly updates: (() => void)[]; holding: boolean };
}

/**
 * A log that a page whose browser went away cannot write any more, as with IndexedDB. With `held`
 * what other windows write arrives only once it is let go, as a BroadcastChannel can take a while.
 */
function pageLibrary(
  library: ProjectLibrary,
  isDead: () => boolean,
  held: { readonly updates: (() => void)[]; holding: boolean },
): ProjectLibrary {
  return new Proxy(library, {
    get(target, key) {
      if (key !== "open") {
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (id: string): Promise<ProjectLog> => {
        const log = await target.open(id);
        return {
          ...log,
          load: () => log.load(),
          async append(update, name) {
            if (isDead()) throw new DOMException("The page went away", "AbortError");
            await log.append(update, name);
          },
          compact: (merge) => log.compact(merge),
          listen: (listener) =>
            log.listen((update) => {
              if (isDead()) return;
              if (held.holding) held.updates.push(() => listener(update));
              else listener(update);
            }),
          close: () => log.close(),
        };
      };
    },
  });
}

/** What goes wrong around the windows, which a test switches on and off. */
export interface Faults {
  /** What the browser keeps about folders cannot be read or written, as a database that fails. */
  bases: boolean;
  /** Files that another program holds on to, so that they cannot be read. */
  readonly unreadable: Set<string>;
}

/** The bases of a page, which fail while `faults.bases` says so. */
function faultyBases(bases: FolderBases, faults: Faults): FolderBases {
  const fail = () => {
    if (faults.bases) throw new DOMException("The database could not be reached", "UnknownError");
  };
  return {
    claim: async (folder) => (fail(), bases.claim(folder)),
    turnOf: async (folder) => (fail(), bases.turnOf(folder)),
    load: async (folder) => (fail(), bases.load(folder)),
    save: async (folder, turn, change) => (fail(), bases.save(folder, turn, change)),
    forget: async (folder) => (fail(), bases.forget(folder)),
  };
}

/** A folder whose files in `faults.unreadable` cannot be read, as when a program holds on to them. */
function faultyFolder(folder: LocalFolder, faults: Faults): LocalFolder {
  return new Proxy(folder, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key !== "file") return typeof value === "function" ? value.bind(target) : value;
      return async (path: string) => {
        const found = await target.file(path);
        if (!faults.unreadable.has(path)) return found;
        const held = new File([], found.name, { lastModified: found.lastModified });
        Object.defineProperty(held, "size", { value: found.size });
        held.arrayBuffer = () =>
          Promise.reject(new DOMException("The file could not be read", "NotReadableError"));
        return held;
      };
    },
  });
}

/** A browser in memory, with its disk and its database. */
export class TestBrowser {
  readonly disk: MemoryDisk;
  /** The logs of projects, which every window of the browser shares. */
  readonly library = new MemoryLibrary();
  readonly windows: TestWindow[] = [];
  readonly faults: Faults = { bases: false, unreadable: new Set() };

  constructor(options?: MemoryDiskOptions, files: Map<string, string> | undefined = fixture()) {
    this.disk = new MemoryDisk(options);
    if (files) putProject(this.disk, files);
  }

  /** Opens the project in a new window: from its log, or from the folder the first time. */
  async open({
    timing,
    start = true,
    writer,
    holding = false,
  }: {
    readonly timing?: Partial<FolderTiming>;
    readonly start?: boolean;
    /** Stands in for how windows take turns, for a window that does not hear of it. */
    readonly writer?: (writer: FolderWriter) => FolderWriter;
    /** What other windows write arrives only once it is let go. */
    readonly holding?: boolean;
  } = {}): Promise<TestWindow> {
    const folders = memoryFolders(this.disk);
    let folder = (await folders.records.get(LOCAL))?.folder;
    if (!folder) {
      this.disk.chooseNext(PROJECT);
      folder = (await folders.choose()) as LocalFolder;
      await folders.records.put({
        id: LOCAL,
        folder,
        project: "atoms-demo",
        name: "原子",
        openedAt: 1,
      });
    }
    if ((this.library.updates.get(LOCAL) ?? []).length === 0) {
      const reading = await readFolder(folder);
      const read = ProjectStore.create(reading.project, reading.sources);
      this.library.summaries.delete(LOCAL);
      await this.library.create(
        { id: LOCAL, name: reading.project.manifest.name },
        read.encodeState(),
      );
      read.destroy();
    }
    const arriving = { updates: [] as (() => void)[], holding };
    const window = { dead: false, arriving } as {
      -readonly [K in keyof TestWindow]: TestWindow[K];
    };
    const project = new ProjectSession(
      pageLibrary(this.library, () => window.dead, arriving),
      memoryAddress(),
      MESSAGES,
    );
    if (!(await project.open(LOCAL))) throw new Error("The project did not open");
    const store = project.store as ProjectStore;
    const session = new FolderSession({
      store,
      folder: faultyFolder(folder, this.faults),
      id: LOCAL,
      bases: faultyBases(folders.bases, this.faults),
      writer: (writer ?? ((given) => given))(folders.writer(LOCAL)),
      log: { saved: () => project.trySave(), caughtUp: () => project.readLog() },
      ...(timing && { timing }),
    });
    const merges: FolderMerge[] = [];
    session.onMerge((merge) => merges.push(merge));
    Object.assign(window, { folders, folder, project, store, session, merges });
    this.windows.push(window);
    if (start) await session.start();
    return window;
  }

  /**
   * Lets time go by, long enough for everything that waits to be over by default: a watch, people
   * stopping, a retry. Writing a file goes on outside of the timers of a test, so each step waits
   * for what the windows have on their way, as a browser would get on with it meanwhile.
   */
  async settle(ms = 12_000, step = 100): Promise<void> {
    for (let passed = 0; passed < ms; passed += step) {
      await vi.advanceTimersByTimeAsync(Math.min(step, ms - passed));
      await this.idle();
    }
  }

  async idle(): Promise<void> {
    await Promise.all(
      this.windows.filter(({ dead }) => !dead).map(({ session }) => session.idle()),
    );
  }

  /**
   * As if the browser crashed, or the computer went off: what pages were writing stays as it was,
   * and the pages are gone. What the database has stays.
   */
  crash(): void {
    for (const window of this.windows) window.dead = true;
    this.disk.crash();
  }
}
