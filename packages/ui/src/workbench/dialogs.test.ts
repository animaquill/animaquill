import { describe, expect, it, vi } from "vitest";
import { Dialogs, type ProgressRequest } from "./dialogs.ts";

const options = { title: "正在做", cancel: "取消", stopping: "正在停下" };
const shown = (dialogs: Dialogs) => dialogs.getSnapshot() as ProgressRequest;

describe("a dialog with several ways to go on", () => {
  const question = {
    title: "怎么办",
    message: "选一个",
    choices: [
      { id: "keep", label: "留着" },
      { id: "go", label: "走", kind: "danger" as const },
    ],
  };

  it("resolves to what people chose", async () => {
    const dialogs = new Dialogs();
    const answer = dialogs.choose(question);
    expect(dialogs.getSnapshot()).toMatchObject({ kind: "choice", ...question });
    dialogs.answer("go");
    expect(await answer).toBe("go");
    expect(dialogs.getSnapshot()).toBeUndefined();
  });

  it("resolves to nothing when they cancel", async () => {
    const dialogs = new Dialogs();
    const answer = dialogs.choose(question);
    dialogs.answer(undefined);
    expect(await answer).toBeUndefined();
  });

  it("gives way to the next dialog, as a cancelled one", async () => {
    const dialogs = new Dialogs();
    const answer = dialogs.choose(question);
    void dialogs.choose(question);
    expect(await answer).toBeUndefined();
  });
});

describe("a dialog for something that takes a while", () => {
  it("shows up, follows along and goes away", () => {
    const dialogs = new Dialogs();
    const progress = dialogs.progress(options);
    expect(shown(dialogs).title).toBe("正在做");

    const { id } = shown(dialogs);
    const listener = vi.fn<() => void>();
    dialogs.subscribe(listener);
    progress.update({ detail: "a.mp4", ratio: 0.5, amount: "1 / 2" });
    expect(shown(dialogs)).toMatchObject({ id, detail: "a.mp4", ratio: 0.5, amount: "1 / 2" });
    progress.update({ title: "在做别的" });
    expect(shown(dialogs)).toMatchObject({ title: "在做别的", detail: "a.mp4" });

    expect(listener).toHaveBeenCalledTimes(2);

    progress.close();
    expect(dialogs.getSnapshot()).toBeUndefined();
  });

  it("asks whoever runs it to stop, and stays until that happened", () => {
    const dialogs = new Dialogs();
    const progress = dialogs.progress(options);
    expect(progress.signal.aborted).toBe(false);
    shown(dialogs).stop();
    expect(progress.signal.aborted).toBe(true);
    expect(shown(dialogs).stopped).toBe(true);
    progress.close();
    expect(dialogs.getSnapshot()).toBeUndefined();
  });

  it("does not come back after it was closed", () => {
    const dialogs = new Dialogs();
    const progress = dialogs.progress(options);
    progress.close();
    progress.update({ detail: "太晚了" });
    expect(dialogs.getSnapshot()).toBeUndefined();
  });

  it("leaves alone the dialog that took its place", async () => {
    const dialogs = new Dialogs();
    const progress = dialogs.progress(options);
    const answer = dialogs.confirm({ title: "确定吗", message: "", confirm: "确定" });
    const question = dialogs.getSnapshot();
    progress.update({ detail: "太晚了" });
    progress.close();
    expect(dialogs.getSnapshot()).toBe(question);
    dialogs.answer(true);
    expect(await answer).toBe(true);
  });

  it("takes the place of a question, which counts as not answered", async () => {
    const dialogs = new Dialogs();
    const answer = dialogs.confirm({ title: "确定吗", message: "", confirm: "确定" });
    dialogs.progress(options);
    expect(await answer).toBe(false);
  });
});

describe("a dialog with choices to make", () => {
  const form = {
    title: "导出视频",
    fields: [
      {
        id: "quality",
        label: "码率",
        value: "standard",
        options: [
          { id: "standard", label: "标准" },
          { id: "high", label: "较高" },
        ],
      },
    ],
    notes: ["没有声音"],
    confirm: "导出",
  };

  it("shows the fields and what to know", () => {
    const dialogs = new Dialogs();
    void dialogs.form(form);
    expect(dialogs.getSnapshot()).toMatchObject({ kind: "form", ...form });
  });

  it("resolves to what was chosen, by field", async () => {
    const dialogs = new Dialogs();
    const asking = dialogs.form(form);
    dialogs.answer({ quality: "high" });
    await expect(asking).resolves.toEqual({ quality: "high" });
  });

  it("resolves to nothing when cancelled", async () => {
    const dialogs = new Dialogs();
    const asking = dialogs.form(form);
    dialogs.answer(undefined);
    await expect(asking).resolves.toBeUndefined();
  });
});
