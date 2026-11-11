/**
 * What the tests of projects of the platform share: a window with what decides whether its project
 * syncs, an account whose state a test sets, and people who answer dialogs.
 */
import { ProjectStore } from "@animaquill/core";
import type {
  AccountAccess,
  AccountSnapshot,
  CloudAccess,
  CloudLink,
  LocalFolder,
  StoragePersistence,
  WindowMemory,
} from "@animaquill/host";
import { createInstance } from "i18next";
import { vi } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import zhCN from "../i18n/zh-CN.json" with { type: "json" };
import { Dialogs, type DialogRequest } from "../workbench/dialogs.ts";
import { MemoryLibrary, memoryAddress, memoryWindow } from "../workbench/memory-library.ts";
import { Notifications } from "../workbench/notifications.ts";
import { ProjectSession, type SessionMessages } from "../workbench/session.ts";
import { MemoryPlatform, TestCloudBrowser, type TestTime } from "./cloud-support.ts";
import { CloudProjects, type LeftBehind } from "./projects.ts";
import { TestWindow, type FakeRepositories } from "./repository-support.ts";

export const t = createInstance();
await t.init({ lng: "zh-CN", resources: { "zh-CN": { translation: zhCN } } });

export const MESSAGES: SessionMessages = {
  createFailed() {},
  notFound() {},
  openFailed() {},
  tooNew() {},
  damaged() {},
  saveFailed() {},
  saveRecovered() {},
};

export function fixtureState(): { id: string; state: Uint8Array } {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  const id = store.getState().manifest.id;
  const state = store.encodeState();
  store.destroy();
  return { id, state };
}

export function account(status: "signedIn" | "signedOut" = "signedIn") {
  let snapshot: AccountSnapshot =
    status === "signedIn"
      ? { status: "signedIn", id: "user-ada", name: "ada", appInstalled: true }
      : { status: "signedOut" };
  const listeners = new Set<() => void>();
  const access: AccountAccess & { set(next: AccountSnapshot): void } = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    refresh: async () => {},
    takeOutcome: () => undefined,
    signIn: () => {},
    installApp: () => {},
    signOut: async () => {},
    set(next) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
  return access;
}

/** Answers every dialog with what `answer` says, as people would; a promise once it settles. */
export function answering(dialogs: Dialogs, answer: (request: DialogRequest) => unknown) {
  const asked: DialogRequest[] = [];
  dialogs.subscribe(() => {
    const request = dialogs.getSnapshot();
    if (!request || request.kind === "progress" || asked.includes(request)) return;
    asked.push(request);
    void Promise.resolve()
      .then(() => answer(request))
      .then((value) => {
        if (dialogs.getSnapshot() === request) {
          dialogs.answer(value as Parameters<Dialogs["answer"]>[0]);
        }
      });
  });
  return asked;
}

/** A browser with one window, and what decides whether its project syncs. */
export async function windowOf(
  platform: MemoryPlatform,
  time: TestTime,
  {
    signedIn = true,
    folders = new Map<string, LocalFolder>(),
    repository,
    browser = new TestCloudBrowser(platform, "ada"),
    library = new MemoryLibrary(),
    memory = memoryWindow(),
    overrides = {},
    persistence,
  }: {
    /** Whether the browser keeps what it stores, see `CloudProjectsOptions.persistence`. */
    persistence?: StoragePersistence;
    signedIn?: boolean;
    folders?: Map<string, LocalFolder>;
    repository?: FakeRepositories;
    /** Another window of a browser that is there already. */
    browser?: TestCloudBrowser;
    library?: MemoryLibrary;
    /** What the window remembers through a reload: the same one for the page that comes back. */
    memory?: WindowMemory;
    /** In place of what the platform does, as for an answer that comes at the wrong moment. */
    overrides?: Partial<CloudAccess>;
  } = {},
) {
  const session = new ProjectSession(library, memoryAddress(), MESSAGES, { window: "w" });
  const dialogs = new Dialogs();
  const notifications = new Notifications();
  const who = account(signedIn ? "signedIn" : "signedOut");
  const signIn = vi.fn(async () => {});
  const installApp = vi.fn(() => {});
  /** What a test says about the world around the window. */
  const world = {
    /** How many other windows have a project open, by its key. */
    others: new Map<string, number>(),
    /** Which windows have a project open cannot be told, see `CloudProjectsOptions.others`. */
    othersFail: false,
    /** Finding out which windows have a project open takes until this is over. */
    othersWait: undefined as Promise<void> | undefined,
    /** What windows left on a project that is not saved, by its key. */
    left: new Map<string, readonly LeftBehind[]>(),
    /** How often the dialog that connects a project was asked for, and what showing it does. */
    shown: 0,
    showConnect: undefined as (() => Promise<void>) | undefined,
    /** Whether people did something just now, see `CloudProjectsOptions.isActive`. */
    active: true,
    /** What moving into a folder comes to: a test that has a folder for it says so. */
    move: async (_key: string): Promise<boolean> => false,
    moved: [] as string[],
    /** Whether the page goes away once it was asked to, see `CloudProjectsOptions.leaving`. */
    leaving: true,
    /** Opening a project only in this browser says that it is not safe, see `CloudProjects`. */
    tellOnlyHere: false,
  };
  const open = async (id: string) => {
    // Tests make projects in the browser on purpose: only those about it hear that it is not safe.
    if (!world.tellOnlyHere) cloud.noteToldOnlyHere(id);
    await cloud.close();
    await session.open(id);
    await cloud.follow();
  };
  const cloud: CloudProjects = new CloudProjects({
    cloud: {
      ...browser.access({ isAlive: () => true, asleep: false }),
      ...(repository && { repository }),
      ...overrides,
    },
    session,
    projects: library,
    folderOf: (key) => folders.get(key),
    isFolder: (key) => folders.has(key),
    // The folders this browser knows: those the test put on its list.
    records: {
      get: async (id) => {
        const folder = folders.get(id);
        return folder && { id, folder, project: "", name: "", openedAt: 0 };
      },
    },
    others: async (key) => {
      await world.othersWait;
      if (world.othersFail) throw new Error("no word from the other windows");
      return world.others.get(key) ?? 0;
    },
    leftBehind: async (key) => world.left.get(key) ?? [],
    showConnect: async () => {
      world.shown += 1;
      await world.showConnect?.();
    },
    closeProject: async () => {
      await cloud.close();
      await session.close();
      return true;
    },
    moveToFolder: async (key) => {
      world.moved.push(key);
      return world.move(key);
    },
    isActive: () => world.active,
    memory,
    ...(persistence && { persistence }),
    leaving: () => world.leaving,
    connectTiming: { patienceMs: 2000, checkMs: 50 },
    account: who,
    dialogs,
    notifications,
    t: t.t,
    window: "w",
    editor: "test",
    signIn,
    openProject: open,
    environment: time,
    timing: { scanMs: 5, noteMs: 20 },
    repositoryEnvironment: new TestWindow(time),
    installApp,
  });
  windows.push({ cloud, session });
  return {
    browser,
    library,
    session,
    dialogs,
    notifications,
    who,
    signIn,
    installApp,
    cloud,
    open,
    folders,
    world,
    memory,
    time,
  };
}

const windows: { cloud: CloudProjects; session: ProjectSession }[] = [];

/** Lets go of every window a test made, for after each test. */
export async function closeWindows(): Promise<void> {
  for (const { cloud, session } of windows.splice(0)) {
    await cloud.close();
    await session.close();
  }
}

/** A window a test made by itself, to be let go of after it. */
export const track = (window: { cloud: CloudProjects; session: ProjectSession }): void => {
  windows.push(window);
};

/**
 * Connects the open project of a window as the first step of the dialog that connects it does,
 * without the dialog, see `CloudProjects.beginLink`: for tests that need a project of the platform.
 */
export async function connectNow(cloud: CloudProjects): Promise<CloudLink> {
  const begun = await cloud.beginLink();
  if (typeof begun === "string") throw new Error(`The project did not begin to connect: ${begun}`);
  return begun.link;
}

export const messagesOf = (notifications: Notifications) =>
  notifications.getSnapshot().map((notification) => notification.message);
