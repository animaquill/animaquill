import { ProjectStore } from "@animaquill/core";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { describe, expect, it, vi } from "vitest";
import { Dialogs } from "../workbench/dialogs.ts";
import { Notifications } from "../workbench/notifications.ts";
import { frameRateChange, masterChange, ratioOf, safeAreaChoice, sameRate } from "./changes.ts";
import { ProjectEdits } from "./edits.ts";

/** The example project without its locked tag, so that it can be changed. */
function open(): ProjectStore {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string);
  delete manifest.tags;
  files.set("animaquill.json", JSON.stringify(manifest));
  const { store } = ProjectStore.open(files);
  if (!store) throw new Error("fixture did not open");
  return store;
}

const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key) as never;

function setup(store = open(), more: { seconds?: number; proxies?: number } = {}) {
  const dialogs = new Dialogs();
  const notifications = new Notifications();
  const pictures: string[] = [];
  const edits = new ProjectEdits({
    t,
    dialogs,
    notifications,
    store: () => store,
    playhead: () => ({ timeline: "main", seconds: more.seconds ?? 0 }),
    proxies: () => more.proxies ?? 0,
    picture: async (state) => {
      const [master] = state.manifest.formats;
      pictures.push(`${master?.width}x${master?.height}`);
      return new Blob(["x"], { type: "image/jpeg" });
    },
  });
  const asked = async () => {
    await vi.waitFor(() => expect(dialogs.getSnapshot()).toBeDefined());
    return dialogs.getSnapshot()!;
  };
  return { store, dialogs, notifications, edits, asked, pictures };
}

const manifest = (store: ProjectStore) => store.getState().manifest;

describe("what the dialogs of the project properties say", () => {
  it("tells sizes of one shape from another", () => {
    const a = { id: "a", name: "A", width: 1920, height: 1080, fps: "30" };
    expect(masterChange([a], [a])).toBe("none");
    expect(masterChange([a], [{ ...a, width: 3840, height: 2160 }])).toBe("size");
    expect(masterChange([a], [{ ...a, width: 1080, height: 1920 }])).toBe("ratio");
    expect(ratioOf(1920, 1080)).toBe("16:9");
    expect(ratioOf(1080, 1920)).toBe("9:16");
  });

  it("counts what is off the new frames, and shows a timecode both ways", () => {
    const store = open();
    const change = frameRateChange(store.getState(), "25", 12.5);
    expect(change.from).toBe("30");
    expect(change.example).toEqual({ before: "0:12/15", after: "0:12/12" });
    expect(change.offGrid).toBeGreaterThan(0);
    expect(change.master).toEqual({ name: "YouTube 横屏", fps: "30" });
    expect(change.masterAlong).toBe(true);
    // Nothing is off the frames of a rate that has every one of the old ones.
    expect(frameRateChange(store.getState(), "30", 0).offGrid).toBe(
      frameRateChange(store.getState(), "60", 0).offGrid,
    );
  });

  it("knows a rate however it is written, and the safe areas by their fractions", () => {
    expect(sameRate("30000/1001", "30000/1001")).toBe(true);
    expect(sameRate("30", "30/1")).toBe(true);
    expect(sameRate("25", "30")).toBe(false);
    const format = { id: "a", name: "A", width: 1920, height: 1080, fps: "30" };
    expect(safeAreaChoice(format)).toBe("none");
    expect(
      safeAreaChoice({ ...format, safeArea: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 } }),
    ).toBe("title");
    expect(
      safeAreaChoice({ ...format, safeArea: { top: 0.1, right: 0.15, bottom: 0.2, left: 0 } }),
    ).toBe("custom");
  });
});

describe("the changes of the project properties", () => {
  it("change the frame rate only once people agree, with the master along as one step", async () => {
    const { store, dialogs, edits, asked } = setup(open(), { proxies: 3 });
    const clips = store.getState().timelines.main?.clips;
    const going = edits.setFrameRate("25");
    const request = await asked();
    expect(request.kind).toBe("form");
    const form = request as Extract<typeof request, { kind: "form" }>;
    expect(form.notes?.join("\n")).toContain("projectProps.fps.nothingMoves");
    expect(form.notes?.join("\n")).toContain("projectProps.fps.offGrid");
    expect(form.notes?.join("\n")).toContain('projectProps.fps.proxies {"count":3');
    expect(form.fields[0]?.value).toBe("along");
    dialogs.answer({ master: "along" });
    expect(await going).toBe(true);
    expect(manifest(store).fps).toBe("25");
    expect(manifest(store).formats[0]?.fps).toBe("25");
    expect(store.getState().timelines.main?.clips).toEqual(clips);
    store.undo();
    expect(manifest(store).fps).toBeUndefined();
    expect(manifest(store).formats[0]?.fps).toBe("30");
  });

  it("leave the frame rate when people cancel, or keep the export rate when they say so", async () => {
    const { store, dialogs, edits, asked } = setup();
    const cancelled = edits.setFrameRate("24");
    await asked();
    dialogs.answer(undefined);
    expect(await cancelled).toBe(false);
    expect(manifest(store).fps).toBeUndefined();
    const kept = edits.setFrameRate("24");
    await asked();
    dialogs.answer({ master: "keep" });
    expect(await kept).toBe(true);
    expect(manifest(store).fps).toBe("24");
    expect(manifest(store).formats[0]?.fps).toBe("30");
  });

  it("refuse a frame rate that is none, without asking", async () => {
    const { store, dialogs, edits, notifications } = setup();
    expect(await edits.setFrameRate("abc")).toBe(false);
    expect(dialogs.getSnapshot()).toBeUndefined();
    expect(notifications.getSnapshot()).toHaveLength(1);
    expect(manifest(store).fps).toBeUndefined();
  });

  it("show the frame before and after a master of another shape, and can add a format instead", async () => {
    const { store, dialogs, edits, asked, pictures } = setup();
    const [master, vertical] = manifest(store).formats;
    const going = edits.setFormats([{ ...master!, width: 1080, height: 1920 }, vertical!]);
    const request = await asked();
    expect(request.kind).toBe("choice");
    const choice = request as Extract<typeof request, { kind: "choice" }>;
    expect(choice.pictures).toHaveLength(2);
    expect(pictures).toEqual(["1920x1080", "1080x1920"]);
    expect(choice.choices.map(({ id }) => id)).toEqual(["change", "add"]);
    dialogs.answer("add");
    expect(await going).toBe(true);
    const formats = manifest(store).formats;
    expect(formats[0]).toEqual(master);
    expect(formats.map(({ width, height }) => `${width}x${height}`)).toEqual([
      "1920x1080",
      "1080x1920",
      "1080x1920",
    ]);
    expect(new Set(formats.map(({ id }) => id)).size).toBe(3);
  });

  it("change the shape of the master once people say so", async () => {
    const { store, dialogs, edits, asked } = setup();
    const [master, vertical] = manifest(store).formats;
    const going = edits.setFormats([{ ...master!, width: 1080, height: 1080 }, vertical!]);
    await asked();
    dialogs.answer("change");
    expect(await going).toBe(true);
    expect(manifest(store).formats[0]).toMatchObject({ width: 1080, height: 1080 });
  });

  it("say what a larger master comes to, and what goes with a format", async () => {
    const { store, dialogs, edits, asked } = setup();
    const [master, vertical] = manifest(store).formats;
    const larger = edits.setFormats([{ ...master!, width: 3840, height: 2160 }, vertical!]);
    const request = await asked();
    expect(request.kind === "confirm" && request.message).toBe("projectProps.size.larger");
    dialogs.answer(true);
    expect(await larger).toBe(true);
    const removing = edits.setFormats([manifest(store).formats[0]!]);
    const asking = await asked();
    expect(asking.kind === "confirm" && asking.details?.[0]?.items).toEqual([
      "timelines/main/overrides/format.vertical.json",
      "timelines/main/overrides/version.en.vertical.json",
    ]);
    dialogs.answer(false);
    expect(await removing).toBe(false);
    expect(manifest(store).formats).toHaveLength(2);
  });

  it("change another format and the order of formats of one shape without asking", async () => {
    const { store, dialogs, edits } = setup();
    const [master, vertical] = manifest(store).formats;
    expect(await edits.setFormats([master!, { ...vertical!, name: "竖的" }])).toBe(true);
    expect(dialogs.getSnapshot()).toBeUndefined();
    expect(manifest(store).formats[1]?.name).toBe("竖的");
  });

  it("list what goes with a language before it goes", async () => {
    const { store, dialogs, edits, asked } = setup();
    const going = edits.setLanguages([manifest(store).languages[0]!]);
    const request = await asked();
    expect(request.kind === "confirm" && request.details?.[0]?.items).toEqual([
      "locales/en.json",
      "timelines/main/overrides/language.en.json",
      "timelines/main/overrides/version.en.vertical.json",
    ]);
    dialogs.answer(true);
    expect(await going).toBe(true);
    expect(manifest(store).languages).toHaveLength(1);
  });

  it("ask before locking and before unlocking", async () => {
    const { store, dialogs, edits, asked } = setup();
    const locking = edits.setTags([{ name: "已交付", locked: true }]);
    await asked();
    dialogs.answer(true);
    expect(await locking).toBe(true);
    expect(manifest(store).tags).toEqual([{ name: "已交付", locked: true }]);
    // Locked, nothing but the tags can change.
    expect(edits.rename("别的")).toBe(false);
    const unlocking = edits.setTags([{ name: "已交付" }]);
    await asked();
    dialogs.answer(false);
    expect(await unlocking).toBe(false);
    expect(manifest(store).tags?.[0]?.locked).toBe(true);
  });

  it("set the background of every timeline as one step", () => {
    const { store, edits } = setup();
    expect(edits.setBackground("#112233")).toBe(true);
    const all = Object.values(store.getState().timelines).map(({ background }) => background);
    expect(all).toEqual(all.map(() => "#112233"));
    store.undo();
    expect(
      Object.values(store.getState().timelines).map(({ background }) => background),
    ).not.toContain("#112233");
  });
});
