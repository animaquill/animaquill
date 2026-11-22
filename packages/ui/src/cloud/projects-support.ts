/**
 * What the tests of projects of the platform share: a window with what decides whether its project
 * syncs, an account whose state a test sets, and people who answer dialogs.
 */
import { ProjectStore } from "@animaquill/core";
import { newSyncId } from "@animaquill/host";
import type {
  AccountAccess,
  AccountSnapshot,
  CloudAccess,
  CloudLink,
  CloudLinks,
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
  const access: CloudAccess = {
    ...browser.access({ isAlive: () => true, asleep: false }),
    ...(repository && { repository }),
    ...overrides,
  };
  const cloud: CloudProjects = new CloudProjects({
    cloud: access,
    session,
    projects: library,
    others: async (key) => {
      await world.othersWait;
      if (world.othersFail) throw new Error("no word from the other windows");
      return world.others.get(key) ?? 0;
    },
    leftBehind: async (key) => world.left.get(key) ?? [],
    closeProject: async () => {
      await cloud.close();
      await session.close();
      return true;
    },
    memory,
    ...(persistence && { persistence }),
    leaving: () => world.leaving,
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
  connecting.set(cloud, { session, links: access.links, platform: access.platform, who });
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

/** What `connectNow` needs of a window that `windowOf` made. */
const connecting = new WeakMap<
  CloudProjects,
  {
    readonly session: ProjectSession;
    readonly links: CloudLinks;
    readonly platform: string;
    readonly who: AccountAccess;
  }
>();

/**
 * Makes the open project of a window a project of the platform for tests that need one: a link
 * that says it is not on the platform yet, which the first connection makes there with what the
 * project is then, as the sync protocol does for "hello" with `create`. People make projects of
 * the platform with the dialog, see `CloudCreate`.
 */
export async function connectNow(cloud: CloudProjects): Promise<CloudLink> {
  const parts = connecting.get(cloud);
  const { session } = parts ?? {};
  const key = session?.key;
  const store = session?.store;
  if (!parts || !session || !key || !store) throw new Error("No project is open to connect");
  if (!(await session.trySave())) throw new Error("The project is not saved");
  const before = await parts.links.get(key);
  if (before) return before;
  const entries = (await session.journal.entries()) ?? [];
  const who = parts.who.getSnapshot();
  const link: CloudLink = {
    key,
    platform: parts.platform,
    project: newSyncId(),
    seq: 0,
    pushed: entries.at(-1)?.mark ?? 0,
    linkedAt: Date.now(),
    creating: true,
    name: store.getState().manifest.name,
    ...(who.status === "signedIn" && who.id !== undefined && { owner: who.id }),
  };
  await parts.links.put(link);
  // Looked at again, as if the project had just opened: it syncs now.
  await cloud.close();
  await cloud.follow();
  return link;
}

export const messagesOf = (notifications: Notifications) =>
  notifications.getSnapshot().map((notification) => notification.message);
