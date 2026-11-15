import { hashTextHex } from "@animaquill/media";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN,
  NOTES,
  PROJECT,
  TestBrowser,
  clipIn,
  clipName,
  editOnDisk,
  renameClip,
  textOn,
} from "./folder-support.ts";
import { createI18n } from "../i18n/i18n.ts";
import { Notifications, type Notification } from "../workbench/notifications.ts";
import { ToolActivity } from "../workbench/tool-activity.ts";
import type { Dialogs } from "../workbench/dialogs.ts";
import { BATCHES_FOLDER } from "./tool-notes.ts";
import type { MemoryDisk } from "@animaquill/host/memory";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** What the local MCP notes down as it writes, see packages/local/src/mcp/notes.ts. */
function noteBatch(
  disk: MemoryDisk,
  batch: string,
  files: Record<string, string | null>,
  client = "claude-code",
): void {
  const now = Date.now();
  disk.write(
    `${PROJECT}/${BATCHES_FOLDER}/${batch}.json`,
    `${JSON.stringify({
      format: 1,
      batch,
      session: "abcdefabcdef",
      client: { name: client, version: "2.1.0" },
      startedAt: now,
      updatedAt: now,
      files,
    })}\n`,
  );
}

/** Changes the notes as an AI tool would, with the note of its batch written first. */
function toolWrites(disk: MemoryDisk, batch: string, text: string): void {
  const document = JSON.parse(textOn(disk, NOTES));
  document.notes[0].text = text;
  const written = `${JSON.stringify(document, null, 4)}\n`;
  noteBatch(disk, batch, { [NOTES]: hashTextHex(written) });
  disk.write(`${PROJECT}/${NOTES}`, written);
}

describe("what an AI tool on this computer writes", () => {
  it("comes in as its batch, one origin for all of it, and goes back as a whole", async () => {
    const browser = new TestBrowser();
    const { store, merges } = await browser.open();
    toolWrites(browser.disk, "b1", "AI 第一次");
    await browser.settle();
    toolWrites(browser.disk, "b1", "AI 第二次");
    await browser.settle();
    expect(merges).toHaveLength(2);
    expect(merges.map(({ tool }) => tool?.batch)).toEqual(["b1", "b1"]);
    expect(merges[0]?.tool?.client?.name).toBe("claude-code");
    expect(merges[0]?.origin).toBe(merges[1]?.origin);
    expect(merges[0]?.atStart).toBe(false);
    expect(store.getState().notes?.["note_1"]?.text).toBe("AI 第二次");
    expect(store.undoOrigin(merges[0]?.origin as string).ok).toBe(true);
    expect(store.getState().notes?.["note_1"]?.text).toBe("字再大一点，放到画面上方");
  });

  it("is nobody's in particular where a file is not as the batch left it", async () => {
    const browser = new TestBrowser();
    const { merges } = await browser.open();
    noteBatch(browser.disk, "b1", { [NOTES]: "0".repeat(64) });
    editOnDisk(browser.disk, NOTES, (document) => {
      document.notes[0].text = "别人改的";
    });
    await browser.settle();
    expect(merges).toHaveLength(1);
    expect(merges[0]?.tool).toBeUndefined();
    expect(merges[0]?.origin).not.toContain("tool-");
  });

  it("while the editor was not there, comes in as the folder is compared on opening", async () => {
    const browser = new TestBrowser();
    await browser.open();
    await browser.settle();
    // The browser goes, as when people closed it.
    browser.crash();
    toolWrites(browser.disk, "b2", "你不在时");
    const { merges, store } = await browser.open();
    await browser.settle();
    expect(store.getState().notes?.["note_1"]?.text).toBe("你不在时");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ atStart: true, tool: { batch: "b2" } });
  });
});

describe("telling people what an AI tool did", async () => {
  const { t } = await createI18n();

  /** What the workbench does with merges of a window, without the page. */
  function activityOf() {
    const notifications = new Notifications();
    // What showed last, as notices go by themselves while the test waits.
    let shown: readonly Notification[] = [];
    notifications.subscribe(() => {
      const now = notifications.getSnapshot();
      if (now.length > 0) shown = now;
    });
    const undone: string[] = [];
    const activity = new ToolActivity({
      t,
      notifications,
      dialogs: {} as Dialogs,
      showProblems: () => {},
      folder: () => undefined,
      held: () => false,
      undo: (origin) => undone.push(origin),
      lookAt: () => {},
    });
    return { shown: () => shown, activity, undone };
  }

  it("counts on in one notice while the batch goes on, and marks its clips", async () => {
    const browser = new TestBrowser();
    const window = await browser.open();
    const { shown, activity } = activityOf();
    window.session.onMerge((merge) => activity.merged(window.store, merge));
    const written = (name: string) => {
      const document = JSON.parse(textOn(browser.disk, MAIN));
      clipIn(document, "clip_title").name = name;
      return `${JSON.stringify(document, null, 4)}\n`;
    };
    let text = written("AI 的");
    noteBatch(browser.disk, "b1", { [MAIN]: hashTextHex(text) });
    browser.disk.write(`${PROJECT}/${MAIN}`, text);
    await browser.settle();
    expect(shown().map(({ message }) => message)).toEqual([
      "Claude Code：把片段「标题」改名为「AI 的」",
    ]);
    expect(activity.getSnapshot().marked).toEqual(new Set(["clip_title"]));
    toolWrites(browser.disk, "b1", "AI 也改了笔记");
    text = written("AI 的");
    await browser.settle();
    const messages = shown().map(({ message }) => message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toBe("Claude Code：把片段「标题」改名为「AI 的」等 2 处");
  });

  it("says where people changed the same thing, and that theirs stayed", async () => {
    const browser = new TestBrowser();
    const window = await browser.open();
    const { shown, activity } = activityOf();
    window.session.onMerge((merge) => activity.merged(window.store, merge));
    // People rename the clip, and the tool does too before the editor wrote it.
    renameClip(window.store, "clip_title", "你的");
    const document = JSON.parse(textOn(browser.disk, MAIN));
    clipIn(document, "clip_title").name = "AI 的";
    clipIn(document, "clip_title").start = "1";
    const text = `${JSON.stringify(document, null, 4)}\n`;
    noteBatch(browser.disk, "b1", { [MAIN]: hashTextHex(text) });
    browser.disk.write(`${PROJECT}/${MAIN}`, text);
    await browser.settle();
    expect(clipName(window.store, "clip_title")).toBe("你的");
    const [notice] = shown();
    expect(notice?.message).toMatch(/^Claude Code：/);
    expect(notice?.warning?.text).toBe("其中 1 处你也改了，保留了你的");
  });
});
