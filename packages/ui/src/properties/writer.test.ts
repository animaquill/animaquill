import { type PropertyEdit } from "@animaquill/core";
import { describe, expect, it, vi } from "vitest";
import { orderedTracks } from "@animaquill/core";
import { TimelineEditor } from "../timeline/editor.ts";
import {
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { TrialSession } from "./trial.ts";
import { PropertyWriter } from "./writer.ts";

async function setup({ trying = false } = {}) {
  const session = new ProjectSession(new MemoryLibrary(), memoryAddress(), {
    createFailed: vi.fn(),
    notFound: vi.fn(),
    openFailed: vi.fn(),
    tooNew: vi.fn(),
    damaged: vi.fn(),
    saveFailed: vi.fn(),
    saveRecovered: vi.fn(),
  });
  await session.create("属性");
  const store = session.store;
  if (!store) throw new Error("no project");
  const settings = {
    load: async (key: string) => (key === "trial" ? { version: 1, enabled: trying } : undefined),
    save: async () => {},
    listen: () => () => {},
  };
  const timeline = new TimelineEditor(session, memoryWindow(), settings, {
    commandFailed: vi.fn(),
  });
  const commandFailed = vi.fn<(message: string) => void>();
  const trials = new TrialSession(session, timeline, new MemoryTrials(), settings, {
    commandFailed,
    overwrote: vi.fn(),
    discarded: vi.fn(),
    setAside: vi.fn(),
    back: vi.fn(),
    asideDropped: vi.fn(),
    unsure: vi.fn(),
    restored: vi.fn(),
    dropped: vi.fn(),
    readFailed: vi.fn(),
    keepFailed: vi.fn(),
    keepRecovered: vi.fn(),
  });
  await trials.load();
  await trials.settle();
  const comparingMessage = vi.fn();
  const writer = new PropertyWriter(session, timeline, trials, {
    commandFailed,
    comparing: comparingMessage,
  });
  const state = () => store.getState().timelines["main"];
  const track = orderedTracks(state() as never).find(({ kind }) => kind === "video")?.id;
  const clip = { id: "c", start: "0", duration: "5", source: { kind: "color", color: "#ff0000" } };
  store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
  const value = (path: string) => state()?.clips["c"]?.properties?.[path];
  const shown = (path: string) => writer.getPreviewed().get("c")?.get(path);
  return { store, writer, trials, commandFailed, comparingMessage, value, shown, track };
}

const owner = { clip: "c" };
const write = (value: number, time = "1", path = "transform.x"): PropertyEdit => ({
  owner,
  path,
  op: "write",
  time,
  value,
});

describe("previewing", () => {
  it("shows a value and leaves the project alone", async () => {
    const { store, writer, shown, value } = await setup();
    const { revision } = store;
    writer.preview([write(10)]);
    expect(shown("transform.x")).toBe(10);
    expect(value("transform.x")).toBeUndefined();
    expect(store.revision).toBe(revision);
    expect(store.canUndo).toBe(true);
  });

  it("tells who is listening, every time", async () => {
    const { writer } = await setup();
    const listener = vi.fn();
    writer.subscribe(listener);
    writer.preview([write(10)]);
    writer.preview([write(20)]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("replaces what was shown before, instead of adding to it", async () => {
    const { writer, shown } = await setup();
    writer.preview([write(10), write(0.5, "1", "opacity")]);
    writer.preview([write(20)]);
    expect(shown("transform.x")).toBe(20);
    expect(shown("opacity")).toBeUndefined();
    expect(writer.getPreviewed().get("c")?.has("opacity")).toBe(false);
  });

  it("works from what the project holds, so a key lands between the others", async () => {
    const { writer, shown, store } = await setup();
    const keys = {
      keys: [
        { time: "0", value: 0 },
        { time: "2", value: 2 },
      ],
    };
    const edit = { owner, path: "transform.x", op: "set", value: keys };
    store.execute({ type: "property.edit", params: { timeline: "main", edits: [edit] } });
    writer.preview([write(9)]);
    expect(shown("transform.x")).toEqual({
      keys: [
        { time: "0", value: 0 },
        { time: "1", value: 9 },
        { time: "2", value: 2 },
      ],
    });
  });

  it("shows exactly what gets written", async () => {
    const { writer, shown, value, store } = await setup();
    const edit = { owner, path: "opacity", op: "setKey", time: "0", value: 1 } as const;
    store.execute({ type: "property.edit", params: { timeline: "main", edits: [edit] } });
    const edits = [write(0.5, "1/3", "opacity")];
    writer.preview(edits);
    const previewed = shown("opacity");
    writer.commit(edits);
    expect(value("opacity")).toEqual(previewed);
  });

  it("takes several edits of one property in order", async () => {
    const { writer, shown } = await setup();
    const x = { owner, path: "transform.x" };
    writer.preview([
      { ...x, op: "setKey", time: "0", value: 1 },
      { ...x, op: "write", time: "1", value: 2 },
    ]);
    expect(shown("transform.x")).toMatchObject({ keys: [{ time: "0" }, { time: "1" }] });
  });

  it("can show that a property goes away", async () => {
    const { writer } = await setup();
    writer.preview([{ owner, path: "opacity", op: "clear" }]);
    expect(writer.getPreviewed().get("c")?.has("opacity")).toBe(true);
    expect(writer.getPreviewed().get("c")?.get("opacity")).toBeUndefined();
  });

  it("passes over a clip that is gone and a key that somebody took away", async () => {
    const { writer, shown } = await setup();
    writer.preview([
      { owner: { clip: "gone" }, path: "opacity", op: "clear" },
      { owner, path: "opacity", op: "removeKey", time: "9" },
      write(3),
    ]);
    expect(shown("transform.x")).toBe(3);
    expect(writer.getPreviewed().has("gone")).toBe(false);
  });
});

describe("cancelling", () => {
  it("goes back to the project, and tells who is listening", async () => {
    const { writer, value } = await setup();
    writer.preview([write(10)]);
    const listener = vi.fn();
    writer.subscribe(listener);
    writer.cancel();
    expect(writer.getPreviewed().size).toBe(0);
    expect(value("transform.x")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("says nothing when nothing was shown", async () => {
    const { writer } = await setup();
    const listener = vi.fn();
    writer.subscribe(listener);
    writer.cancel();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("committing", () => {
  it("writes, as one step, however many edits it is", async () => {
    const { store, writer, value } = await setup();
    expect(writer.commit([write(10), write(0.5, "1", "opacity")])).toBe(true);
    expect(value("transform.x")).toBe(10);
    expect(value("opacity")).toBe(0.5);
    store.undo();
    expect(value("transform.x")).toBeUndefined();
    expect(value("opacity")).toBeUndefined();
  });

  it("leaves one step after a whole drag", async () => {
    const { store, writer, value } = await setup();
    const steps = () => store.history.length;
    const before = steps();
    for (const position of [1, 2, 3, 4, 5]) writer.preview([write(position)]);
    expect(steps()).toBe(before);
    writer.commit([write(5)]);
    expect(steps()).toBe(before + 1);
    store.undo();
    expect(value("transform.x")).toBeUndefined();
  });

  it("ends the preview after the project has the value, so that nothing flashes", async () => {
    const { store, writer, value } = await setup();
    const order: string[] = [];
    store.subscribe(() => order.push(`project ${String(value("transform.x"))}`));
    writer.preview([write(1)]);
    writer.subscribe(() => order.push(`preview ${writer.getPreviewed().size}`));
    writer.commit([write(1)]);
    expect(order).toEqual(["project 1", "preview 0"]);
  });

  it("says when it fails, and still ends the preview", async () => {
    const { store, writer, commandFailed } = await setup();
    store.execute({
      type: "project.setTags",
      params: { tags: [{ name: "已发布", locked: true }] },
    });
    writer.preview([write(1)]);
    expect(writer.commit([write(1)])).toBe(false);
    expect(commandFailed).toHaveBeenCalledOnce();
    expect(writer.getPreviewed().size).toBe(0);
  });

  it("with nothing to write only ends the preview", async () => {
    const { store, writer, commandFailed } = await setup();
    const { revision } = store;
    writer.preview([write(1)]);
    expect(writer.commit([])).toBe(false);
    expect(writer.getPreviewed().size).toBe(0);
    expect(commandFailed).not.toHaveBeenCalled();
    expect(store.revision).toBe(revision);
  });
});

describe("while people try things out", () => {
  const trying = { trying: true };

  it("a step goes there, and the project stays as it is", async () => {
    const { store, writer, trials, value, shown } = await setup(trying);
    const { revision } = store;
    expect(writer.commit([write(10)])).toBe(true);
    expect(value("transform.x")).toBeUndefined();
    expect(store.revision).toBe(revision);
    expect(trials.getSnapshot().count).toBe(1);
    expect(shown("transform.x")).toBe(10);
  });

  it("the picture keeps it after the step", async () => {
    const { writer, shown } = await setup(trying);
    writer.preview([write(10)]);
    writer.commit([write(10)]);
    expect(shown("transform.x")).toBe(10);
  });

  it("a drag starts from what is being tried, not from what is saved", async () => {
    const { writer, shown, store } = await setup(trying);
    const key = { owner, path: "transform.x", op: "setKey", time: "0", value: 1 } as const;
    writer.commit([key]);
    writer.preview([write(9)]);
    expect(shown("transform.x")).toEqual({
      keys: [
        { time: "0", value: 1 },
        { time: "1", value: 9 },
      ],
    });
    expect(store.getState().timelines["main"]?.clips["c"]?.properties).toBeUndefined();
  });

  it("a drag that gets cancelled goes back to what is being tried", async () => {
    const { writer, shown } = await setup(trying);
    writer.commit([write(10)]);
    writer.preview([write(20)]);
    expect(shown("transform.x")).toBe(20);
    writer.cancel();
    expect(shown("transform.x")).toBe(10);
  });

  it("a drag on one property leaves the others in the picture", async () => {
    const { writer, shown } = await setup(trying);
    writer.commit([write(0.5, "1", "opacity")]);
    writer.preview([write(20)]);
    expect(shown("opacity")).toBe(0.5);
    expect(shown("transform.x")).toBe(20);
  });

  it("a drag on one clip leaves what is tried on the others in the picture", async () => {
    const { writer, shown, store, track } = await setup(trying);
    const clip = {
      id: "d",
      start: "9",
      duration: "1",
      source: { kind: "color", color: "#00ff00" },
    };
    store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
    writer.commit([{ owner: { clip: "d" }, path: "opacity", op: "set", value: 0.5 }]);
    writer.preview([write(20)]);
    expect(shown("transform.x")).toBe(20);
    expect(writer.getPreviewed().get("d")?.get("opacity")).toBe(0.5);
  });

  it("the picture hears about what happens to what is being tried", async () => {
    const { writer, trials, shown } = await setup(trying);
    writer.commit([write(10)]);
    const listener = vi.fn();
    writer.subscribe(listener);
    trials.discard();
    expect(listener).toHaveBeenCalled();
    expect(shown("transform.x")).toBeUndefined();
  });

  it("comparing shows the project, and going back shows what is being tried", async () => {
    const { writer, trials, shown } = await setup(trying);
    writer.commit([write(10)]);
    trials.toggleCompare();
    expect(writer.getPreviewed().size).toBe(0);
    trials.toggleCompare();
    expect(shown("transform.x")).toBe(10);
  });

  it("says when something cannot be tried, like when it cannot be written", async () => {
    const { store, writer, commandFailed, trials } = await setup(trying);
    store.execute({
      type: "project.setTags",
      params: { tags: [{ name: "已发布", locked: true }] },
    });
    expect(writer.commit([write(1)])).toBe(false);
    expect(commandFailed).toHaveBeenCalledOnce();
    expect(trials.getSnapshot().count).toBe(0);
  });

  it("what is being tried stays in charge after the setting went off", async () => {
    const { store, writer, trials, value, shown } = await setup(trying);
    writer.commit([write(10)]);
    trials.setEnabled(false);
    writer.commit([write(20)]);
    expect(value("transform.x")).toBeUndefined();
    expect(shown("transform.x")).toBe(20);
    trials.save();
    expect(value("transform.x")).toBe(20);
    writer.commit([write(30)]);
    expect(value("transform.x")).toBe(30);
    expect(store.canUndo).toBe(true);
  });
});

describe("automatic handles", () => {
  /** Keys at 0, 1 and 2 seconds, the one in the middle with handles the editor works out. */
  async function automatic(trying: boolean) {
    const setting = await setup({ trying });
    const keys = [
      { time: "0", value: 0, interp: "bezier" as const, out: [0.3, 0.3] as [number, number] },
      {
        time: "1",
        value: 10,
        interp: "bezier" as const,
        tangent: "auto" as const,
        out: [0.333333, 0.333333] as [number, number],
        in: [0.666667, 0.666667] as [number, number],
      },
      { time: "2", value: 20 },
    ];
    setting.store.execute({
      type: "property.edit",
      params: {
        timeline: "main",
        edits: [{ owner, path: "transform.x", op: "set", value: { keys } }],
      },
    });
    return setting;
  }

  const middle = (value: unknown) =>
    (value as { keys: { out?: number[]; in?: number[] }[] } | undefined)?.keys[1];

  it("follow what moves around them, on the way and in the same step", async () => {
    for (const trying of [false, true]) {
      const { writer, shown, value, store, trials } = await automatic(trying);
      const saved = JSON.stringify(value("transform.x"));
      const steps = store.history.length;
      writer.preview([write(40, "2")]);
      const previewed = middle(shown("transform.x"));
      // The rise after the key is three times the one before it: it leaves steeper than a line.
      expect(previewed?.out?.[1]).toBeLessThan(0.333333);
      expect(previewed?.in?.[1]).toBeLessThan(0.666667);
      writer.commit([write(40, "2")]);
      const after = trying ? trials.getValues().get("c")?.get("transform.x") : value("transform.x");
      expect(middle(after)).toEqual(previewed);
      expect((after as { keys: { value: number }[] }).keys[2]?.value).toBe(40);
      if (trying) {
        expect(trials.getSnapshot().count).toBe(1);
        trials.undo();
        expect(trials.getValues().get("c")?.get("transform.x")).toBeUndefined();
        expect(trials.canUndo).toBe(false);
      } else {
        // One step: one undo takes the value and the handles back together.
        expect(store.history.length).toBe(steps + 1);
        store.undo();
        expect(JSON.stringify(value("transform.x"))).toBe(saved);
      }
    }
  });

  it("are not written while people compare with what is saved, nor is anything else", async () => {
    const { writer, trials, store, comparingMessage } = await automatic(true);
    writer.commit([write(5, "1")]);
    const tried = JSON.stringify(trials.getValues().get("c")?.get("transform.x"));
    trials.toggleCompare();
    const { revision } = store;
    expect(writer.commit([write(30, "2")])).toBe(false);
    expect(comparingMessage).toHaveBeenCalledTimes(1);
    trials.toggleCompare();
    expect(JSON.stringify(trials.getValues().get("c")?.get("transform.x"))).toBe(tried);
    expect(store.revision).toBe(revision);
  });

  it("leave everything else as it is", async () => {
    const { writer, value } = await setup();
    const key = (time: string, number: number): PropertyEdit => ({
      owner,
      path: "transform.x",
      op: "setKey",
      time,
      value: number,
    });
    writer.commit([key("0", 0), key("2", 20)]);
    writer.commit([write(5, "0"), write(15, "2")]);
    expect(value("transform.x")).toEqual({
      keys: [
        { time: "0", value: 5 },
        { time: "2", value: 15 },
      ],
    });
  });
});
