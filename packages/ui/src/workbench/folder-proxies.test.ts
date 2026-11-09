/**
 * Proxies of a project folder in the workbench: they go into the folder without the folder taking
 * them for changes from outside, the preview gets them, an export never does, and a report says
 * which the preview decodes.
 */
import type { ProjectStore } from "@animaquill/core";
import type { ProxyResult } from "@animaquill/media/proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyMaker } from "../proxy/maker.ts";
import { PROXY_FOLDER, proxyName } from "../proxy/spec.ts";
import { memoryFolders } from "@animaquill/host/memory";
import {
  FAST,
  answer,
  browserOf,
  closeWindows,
  folderOf,
  windowOf,
  written,
} from "./folder-windows.ts";

vi.mock("@animaquill/media", async (original) => ({
  ...(await original<typeof import("@animaquill/media")>()),
  // What the browser would find out about these files: a 4K video at 60 frames.
  probeMedia: async () => ({ kind: "video", duration: 3, width: 3840, height: 2160, fps: 60 }),
}));

vi.mock("@animaquill/media/proxy", async (original) => ({
  ...(await original<typeof import("@animaquill/media/proxy")>()),
  // What a proxy here holds, see `maker`.
  isProxy: async (file: Blob) => (await file.text()) === "代理 960x540",
}));

afterEach(closeWindows);

const ROOT = "文档/片子";

/** Makes every proxy at once, as a small file that says what it is. */
const maker: ProxyMaker = {
  make(request) {
    const done = (async (): Promise<ProxyResult> => {
      await request.write(
        new TextEncoder().encode(`代理 ${request.spec.width}x${request.spec.height}`),
        0,
      );
      return {
        frames: 90,
        keys: 6,
        duration: 3,
        sourceDuration: 3,
        timing: {
          totalMs: 900,
          decodeMs: 300,
          drawMs: 200,
          frameMs: 100,
          encodeMs: 250,
          pausedMs: 0,
        },
      };
    })();
    return { done, pause() {}, resume() {}, cancel() {} };
  },
};

/** A new project in a folder, open in a window that makes proxies, with all of it in the folder. */
async function newFolderProject() {
  const browser = browserOf();
  browser.disk.folder(ROOT);
  // Watches that say what changed right away, so that what they would say is said in the test.
  const workbench = windowOf(browser, memoryFolders(browser.disk, FAST), undefined, maker);
  browser.disk.chooseNext(ROOT);
  const creating = workbench.newProject();
  await answer(workbench, "片子");
  await creating;
  await written(workbench);
  const store = workbench.session.store as ProjectStore;
  const key = folderOf(workbench)?.record.id as string;
  return { disk: browser.disk, workbench, store, key };
}

describe("the proxy of a video in a project folder", () => {
  it("goes into the folder, which takes it for no change from outside", async () => {
    const { disk, workbench, store } = await newFolderProject();
    const merges: unknown[] = [];
    workbench.projectFolders?.session?.onMerge((merge) => void merges.push(merge));
    const changed = vi.spyOn(workbench.media, "filesChanged");
    const [id] = await workbench.media.importFiles([
      new File(["4K 视频"], "大.mp4", { type: "video/mp4" }),
    ]);
    const hash = store.getState().assets?.[id as string]?.hash as string;
    await vi.waitFor(() =>
      expect(workbench.proxies?.stateOf(id as string)).toEqual({ kind: "ready" }),
    );
    const name = proxyName(hash, { width: 960, height: 540, fps: { num: 30, den: 1 } });
    expect(disk.names(`${ROOT}/${PROXY_FOLDER}`)).toEqual([name]);
    expect(disk.text(`${ROOT}/.animaquill/.gitignore`)).toBe("*\n");
    // Long enough for watches that would have seen it to say so.
    await workbench.projectFolders?.session?.flush();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(merges).toEqual([]);
    expect(changed.mock.calls.flat(2).filter((path) => path.includes("proxies"))).toEqual([]);
    expect(folderOf(workbench)?.snapshot).toMatchObject({ status: "saved", blocked: [] });
    expect(workbench.problems.getSnapshot().problems).toEqual([]);
  });

  it("is for the preview, and an export gets the video itself", async () => {
    const { workbench, store, key } = await newFolderProject();
    const [id] = await workbench.media.importFiles([
      new File(["4K 视频"], "大.mp4", { type: "video/mp4" }),
    ]);
    const hash = store.getState().assets?.[id as string]?.hash as string;
    await vi.waitFor(() => expect(workbench.proxies?.standInFor(hash)).toBeDefined());
    expect(await workbench.proxies?.standInFor(hash)?.file.text()).toBe("代理 960x540");
    // What exports and the rest of the editor read the files of a project with.
    expect(await (await workbench.projects.media(key).get(hash))?.text()).toBe("4K 视频");
    const forExport = workbench.projectFolders?.mediaFor(key, Date.now());
    expect(await (await forExport?.get(hash))?.text()).toBe("4K 视频");
  });

  it("is in a report: whether there is one, and the quality that decides whether it is used", async () => {
    const { workbench } = await newFolderProject();
    const [id] = await workbench.media.importFiles([
      new File(["4K 视频"], "大.mp4", { type: "video/mp4" }),
    ]);
    await vi.waitFor(() =>
      expect(workbench.proxies?.stateOf(id as string)).toEqual({ kind: "ready" }),
    );
    // What a report says about the screen, which there is none of here.
    vi.stubGlobal("screen", { width: 1920, height: 1080 });
    vi.stubGlobal("devicePixelRatio", 1);
    vi.stubGlobal("innerWidth", 1440);
    vi.stubGlobal("innerHeight", 900);
    workbench.finishDiagnostics();
    vi.unstubAllGlobals();
    const project = workbench.diagnostics.getSnapshot().report?.project as {
      assets: { kind: string; proxy?: string }[];
      previewQuality: string;
    };
    expect(project.assets).toEqual([
      expect.objectContaining({
        kind: "video",
        proxy: "ready",
        // How long making it took here, for what it takes on this computer.
        proxyMade: expect.objectContaining({ seconds: 3, totalMs: 900, drawMs: 200 }),
      }),
    ]);
    expect(project.previewQuality).toBe("auto");
    expect(JSON.stringify(project)).not.toContain("大.mp4");
  });
});
