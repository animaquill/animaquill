/**
 * Renaming a project folder from the start page, without opening it (the design of the start page,
 * 6.6): only the window that writes the folder writes the name into it, the next time it opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL, TestBrowser, editOnDisk, recovered, textOn } from "../folder/folder-support.ts";
import { renameUnopened } from "./rename.ts";

const MANIFEST = "animaquill.json";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const manifestOn = (browser: TestBrowser) => JSON.parse(textOn(browser.disk, MANIFEST));

describe("renaming a project folder that is not open", () => {
  it("writes the name into the folder once it opens", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    await browser.settle();
    await first.session.close();
    await first.project.close();
    expect(await renameUnopened(LOCAL, "开始页改的", { projects: browser.library })).toBe(
      "renamed",
    );
    // Nothing changes in the folder meanwhile.
    expect(manifestOn(browser).name).not.toBe("开始页改的");
    const next = await browser.open();
    await browser.settle();
    expect(next.store.getState().manifest.name).toBe("开始页改的");
    expect(manifestOn(browser).name).toBe("开始页改的");
  });

  it("keeps the name of the start page where a program outside renamed it too, and keeps that version aside", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    await browser.settle();
    await first.session.close();
    await first.project.close();
    expect(await renameUnopened(LOCAL, "开始页改的", { projects: browser.library })).toBe(
      "renamed",
    );
    editOnDisk(browser.disk, MANIFEST, (document) => {
      document.name = "外面改的";
      document.description = "外面加的说明";
    });
    const theirs = textOn(browser.disk, MANIFEST);
    const next = await browser.open();
    await browser.settle();
    const state = next.store.getState().manifest;
    expect(state.description).toBe("外面加的说明");
    expect(manifestOn(browser).description).toBe("外面加的说明");
    expect(state.name).toBe("开始页改的");
    expect(manifestOn(browser).name).toBe("开始页改的");
    expect(recovered(browser.disk).get(MANIFEST)).toEqual([theirs]);
  });

  it("takes in what a program outside changed besides, with no conflict", async () => {
    const browser = new TestBrowser();
    const first = await browser.open();
    await browser.settle();
    await first.session.close();
    await first.project.close();
    expect(await renameUnopened(LOCAL, "开始页改的", { projects: browser.library })).toBe(
      "renamed",
    );
    editOnDisk(browser.disk, MANIFEST, (document) => {
      document.description = "外面加的说明";
    });
    const next = await browser.open();
    await browser.settle();
    expect(next.store.getState().manifest.description).toBe("外面加的说明");
    expect(manifestOn(browser)).toMatchObject({ name: "开始页改的", description: "外面加的说明" });
    expect(next.merges.flatMap((m) => m.conflicts)).toHaveLength(0);
  });

  it("reaches a window that has it open and writes the folder, and is not on its undo stack", async () => {
    const browser = new TestBrowser();
    const w = await browser.open();
    await browser.settle();
    // A change of the window, on its undo stack.
    const ok = w.store.execute({ type: "project.setFrameRate", params: { fps: "25" } });
    expect(ok.ok).toBe(true);
    await browser.settle();
    expect(await renameUnopened(LOCAL, "开始页改的", { projects: browser.library })).toBe(
      "renamed",
    );
    await browser.settle();
    expect(w.store.getState().manifest.name).toBe("开始页改的");
    expect(manifestOn(browser).name).toBe("开始页改的");
    // Undo takes back that one, and the name stays.
    w.store.undo();
    await browser.settle();
    expect(w.store.getState().manifest.name).toBe("开始页改的");
    expect(w.store.getState().manifest.fps).not.toBe("25");
  });
});
