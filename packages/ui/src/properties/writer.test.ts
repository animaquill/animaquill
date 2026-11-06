import { type PropertyEdit } from "@animaquill/core";
import { describe, expect, it, vi } from "vitest";
import { orderedTracks } from "@animaquill/core";
import { TimelineEditor } from "../timeline/editor.ts";
import { MemoryLibrary, memoryAddress, memoryWindow } from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { PropertyWriter } from "./writer.ts";

async function setup() {
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
    load: async () => undefined,
    save: async () => {},
    listen: () => () => {},
  };
  const timeline = new TimelineEditor(session, memoryWindow(), settings, {
    commandFailed: vi.fn(),
  });
  const commandFailed = vi.fn<(message: string) => void>();
  const writer = new PropertyWriter(session, timeline, { commandFailed });
  const state = () => store.getState().timelines["main"];
  const track = orderedTracks(state() as never).find(({ kind }) => kind === "video")?.id;
  const clip = { id: "c", start: "0", duration: "5", source: { kind: "color", color: "#ff0000" } };
  store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
  const value = (path: string) => state()?.clips["c"]?.properties?.[path];
  const shown = (path: string) => writer.getPreviewed().get("c")?.get(path);
  return { store, writer, commandFailed, value, shown, track };
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
    const { store, writer, commandFailed, track } = await setup();
    const changes = { locked: true };
    store.execute({ type: "track.update", params: { timeline: "main", track, changes } });
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
