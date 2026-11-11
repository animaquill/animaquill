/**
 * Windows of a browser in memory, with a disk of project folders, for tests of the workbench: each
 * window has a workbench, and they share the disk, the log of projects and the address.
 */
import { memoryOrganizer } from "@animaquill/host";
import type { FolderAccess, Host, LocalFolders } from "@animaquill/host";
import { MemoryDisk, memoryFolders } from "@animaquill/host/memory";
import { MANIFEST_FILE } from "@animaquill/schema";
import { expect, vi } from "vitest";
import type { Hasher } from "../media/hasher.ts";
import type { ProxyMaker } from "../proxy/maker.ts";
import {
  MemoryExports,
  MemoryLibrary,
  MemoryPresence,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "./memory-library.ts";
import { Workbench } from "./workbench.ts";
import { layouts } from "./layouts.ts";

const noFolders: FolderAccess = {
  chooseSource: async () => undefined,
  chooseTarget: async () => undefined,
  saveFile: () => {},
  chooseFile: async () => undefined,
  reopen: async () => "gone" as const,
  dropTarget: async () => false,
  savesInBrowser: false,
};

export const FAST = { quietMs: 20, longestMs: 200, retryMs: 100, settleMs: 50, answerMs: 100 };

/** A browser, which every window of it shares: the disk, the log of projects, the address. */
export function browserOf(disk = new MemoryDisk()) {
  return {
    disk,
    library: new MemoryLibrary(),
    address: memoryAddress(),
    values: new Map(),
    localFolders: memoryFolders(disk),
    /** Which windows have which projects open: every window of the browser shares it. */
    presence: new MemoryPresence(),
    organizer: memoryOrganizer(),
  };
}

const opened: Workbench[] = [];

/** Lets go of the folders of every window, for after each test. */
export async function closeWindows(): Promise<void> {
  for (const workbench of opened.splice(0)) {
    workbench.proxies?.dispose();
    await workbench.projectFolders?.close();
  }
}

/** A window of that browser, with folders of its own, as a page has. */
export function windowOf(
  browser: ReturnType<typeof browserOf>,
  localFolders?: LocalFolders,
  hasher?: Hasher,
  proxyMaker?: ProxyMaker,
) {
  const { values } = browser;
  const host: Host = {
    projects: browser.library,
    address: browser.address,
    windowMemory: memoryWindow(),
    organizer: browser.organizer,
    settings: {
      load: async (key) => values.get(key),
      save: async (key, value) => void values.set(key, value),
      listen: () => () => {},
    },
    folders: noFolders,
    localFolders: localFolders ?? memoryFolders(browser.disk),
    trials: new MemoryTrials(),
    drafts: new MemoryTrials(),
    exports: new MemoryExports(),
    presence: browser.presence.window(),
  };
  const workbench = new Workbench({
    host,
    t: ((key: string, words?: Record<string, unknown>) =>
      words ? `${key} ${JSON.stringify(words)}` : key) as never,
    version: "test",
    platform: "other",
    panels: [],
    layouts,
    compositorUrl: "",
    folderTiming: FAST,
    ...(hasher && { hasher }),
    ...(proxyMaker && { proxyMaker }),
  });
  opened.push(workbench);
  return workbench;
}

/** Answers the next question, once it is asked. */
export async function answer(workbench: Workbench, value: unknown) {
  await vi.waitFor(() => expect(workbench.dialogs.getSnapshot()).toBeDefined());
  const asked = workbench.dialogs.getSnapshot();
  workbench.dialogs.answer(value as never);
  return asked;
}

/** Opens a project folder that this browser does not know yet, which has code in it. */
export async function openAt(
  browser: ReturnType<typeof browserOf>,
  workbench: Workbench,
  path: string,
) {
  browser.disk.chooseNext(path);
  const opening = workbench.openFolder();
  // People hear about the code the first time the project comes into this browser.
  expect(await answer(workbench, true)).toMatchObject({ title: "transfer.codeTitle" });
  await opening;
}

export const nameOf = (workbench: Workbench) => workbench.session.store?.getState().manifest.name;
export const folderOf = (workbench: Workbench) => workbench.projectFolders?.getSnapshot().open;
export const manifestOn = (disk: MemoryDisk, path: string) =>
  JSON.parse(disk.text(`${path}/${MANIFEST_FILE}`)) as { id: string; name: string };
export const notices = (workbench: Workbench) =>
  workbench.notifications.getSnapshot().map(({ message }) => message);

/** Until the open folder has everything, as a page that goes on would get there. */
export async function written(workbench: Workbench) {
  try {
    await vi.waitFor(() => expect(folderOf(workbench)?.snapshot.status).toBe("saved"), {
      timeout: 3000,
    });
  } catch (error) {
    console.warn("The folder did not get everything", folderOf(workbench)?.snapshot);
    throw error;
  }
}
