import { ProjectStore } from "@animaquill/core";
import { memoryChatImages } from "@animaquill/host";
import { StillFailed, type LookSpec } from "@animaquill/render";
import { createProject, writeProject } from "@animaquill/schema";
import type { LookRequest } from "@animaquill/tools";
import { describe, expect, it, vi } from "vitest";
import { FrameLooks, lookPlan, type FrameLooksOptions } from "./looks.ts";

/**
 * Looking at frames for AI (mcp.md 8): it gives way to people playing and exporting, waits for the
 * page to show, renders each moment once at the size asked for, and says which moment failed.
 */

function openStore(): ProjectStore {
  const { store } = ProjectStore.open(writeProject(createProject({ name: "看" })));
  if (!store) throw new Error("no project");
  return store;
}

const request = (
  state = openStore().getState(),
  extra: Partial<LookRequest> = {},
): LookRequest => ({
  state,
  timeline: "main",
  format: undefined,
  kind: "frames",
  shots: [{ seconds: 1, label: "1", marks: [] }],
  size: undefined,
  texts: true,
  ...extra,
});

function setUp(extra: Partial<FrameLooksOptions> = {}) {
  let busy: "playing" | "exporting" | undefined;
  let hidden = false;
  const listeners = new Set<() => void>();
  const asked: LookSpec[] = [];
  const disposed = vi.fn();
  const look = vi.fn(async (spec: LookSpec) => {
    asked.push(spec);
    return {
      image: new Blob(["jpeg"], { type: "image/jpeg" }),
      width: 1024,
      height: 576,
      ...(spec.lossless && { lossless: new Blob(["png"], { type: "image/png" }) }),
      ...(spec.base && { diff: { image: new Blob(["d"], { type: "image/jpeg" }), ratio: 0.1 } }),
      texts: [],
    };
  });
  const notify = vi.fn();
  const looks = new FrameLooks({
    compositor: () => ({ look, dispose: disposed }),
    images: memoryChatImages(),
    busy: () => busy,
    waitsForPlayback: () => true,
    size: () => "medium",
    hidden: () => hidden,
    watch: (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    notify,
    ...extra,
  });
  const change = (to: { busy?: typeof busy; hidden?: boolean }) => {
    if ("busy" in to) busy = to.busy;
    if (to.hidden !== undefined) hidden = to.hidden;
    for (const listener of listeners) listener();
  };
  return { looks, look, asked, disposed, notify, change };
}

describe("frames for AI", () => {
  it("are as large as the setting says, and a part of the picture fills one", () => {
    const base = { width: 1920, height: 1080, stage: { width: 1920, height: 1080 } } as never;
    expect(lookPlan(base, 1024)).toMatchObject({ width: 1024, height: 576 });
    const part = lookPlan(base, 1024, { x: -960, y: 0, width: 960, height: 540 });
    expect(part).toMatchObject({ width: 1024, height: 576 });
    expect(part.camera).toEqual({
      "camera.x": { kind: "still", value: -480 },
      "camera.y": { kind: "still", value: 270 },
      "camera.zoom": { kind: "still", value: 2 },
    });
    // An overview of 12 in 5 columns is 1024 wide in all.
    expect(lookPlan(base, 1024, undefined, { count: 12, columns: 5 })).toMatchObject({
      width: 205,
      height: 115,
    });
  });

  it("wait while people play or export, and go on once they stop", async () => {
    const { looks, look, change } = setUp();
    change({ busy: "playing" });
    const answer = looks.look(request(), true);
    await vi.waitFor(() => expect(looks.getSnapshot()).toEqual({ kind: "playing" }));
    expect(look).not.toHaveBeenCalled();
    change({ busy: "exporting" });
    await vi.waitFor(() => expect(looks.getSnapshot()).toEqual({ kind: "exporting" }));
    change({ busy: undefined });
    const done = await answer;
    expect(done).toMatchObject({ ok: true, sees: true, width: 1024, height: 576 });
    expect(look).toHaveBeenCalledTimes(1);
    expect(looks.getSnapshot()).toEqual({ kind: "idle" });
  });

  it("do not wait for playing where the settings say so, and still give way to an export", async () => {
    const { looks, look, change } = setUp({ waitsForPlayback: () => false });
    change({ busy: "playing" });
    await looks.look(request(), true);
    expect(look).toHaveBeenCalledTimes(1);
    change({ busy: "exporting" });
    const answer = looks.look(request(), true);
    await vi.waitFor(() => expect(looks.getSnapshot()).toEqual({ kind: "exporting" }));
    change({ busy: undefined });
    await answer;
    expect(look).toHaveBeenCalledTimes(2);
  });

  it("wait for the page to show, and tell people once", async () => {
    const { looks, look, change, notify } = setUp();
    change({ hidden: true });
    const answer = looks.look(
      request(undefined, {
        shots: [
          { seconds: 1, label: "1", marks: [] },
          { seconds: 2, label: "2", marks: [] },
        ],
      }),
      true,
    );
    await vi.waitFor(() => expect(looks.getSnapshot()).toEqual({ kind: "hidden" }));
    expect(notify).toHaveBeenCalledTimes(1);
    change({ hidden: false });
    await answer;
    expect(look).toHaveBeenCalledTimes(2);
  });

  it("stop with the task while they wait", async () => {
    const { looks, change } = setUp();
    change({ busy: "playing" });
    const controller = new AbortController();
    const answer = looks.look(request(), true, controller.signal);
    await vi.waitFor(() => expect(looks.getSnapshot()).toEqual({ kind: "playing" }));
    controller.abort();
    expect(await answer).toEqual({ ok: false, shot: 0, failure: { reason: "stopped" } });
  });

  it("render the frame before and compare with it, and keep nothing for a model that does not see", async () => {
    const { looks, asked } = setUp();
    const state = openStore().getState();
    const answer = await looks.look(request(state, { before: state }), false);
    expect(asked.map(({ lossless, base }) => [lossless === true, base !== undefined])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(answer).toMatchObject({ ok: true, sees: false, shots: [{ changed: { ratio: 0.1 } }] });
    expect(answer.ok && answer.shots[0]?.picture).toBeUndefined();
  });

  it("say which moment has no picture, and why", async () => {
    const { looks } = setUp({
      compositor: () => ({
        look: async (spec) => {
          if (spec.cells[0]?.seconds === 2)
            throw new StillFailed({ reason: "missing-file", layer: "clip_a", file: "f" });
          return { image: new Blob(["x"]), width: 10, height: 10, texts: [] };
        },
        dispose: () => {},
      }),
    });
    const answer = await looks.look(
      request(undefined, {
        shots: [
          { seconds: 1, label: "1", marks: [] },
          { seconds: 2, label: "2", marks: [] },
        ],
      }),
      true,
    );
    expect(answer).toEqual({
      ok: false,
      shot: 1,
      failure: { reason: "missing-file", layer: "clip_a", file: "f" },
    });
  });
});

describe("pictures before and after a change, for people", () => {
  it("render the moment of each state at the size asked for, keep nothing, and never wait", async () => {
    const images = memoryChatImages();
    const save = vi.spyOn(images, "save");
    const { looks, asked, disposed, change } = setUp({ images });
    change({ busy: "playing", hidden: true });
    const state = openStore().getState();
    const answer = await looks.pictures({
      before: state,
      after: state,
      timeline: "main",
      seconds: 2,
      side: 320,
    });
    expect(answer).toMatchObject({
      before: { ok: true, width: 1024, height: 576 },
      after: { ok: true, width: 1024, height: 576 },
    });
    expect(asked).toHaveLength(2);
    expect(asked.every((spec) => spec.cells[0]?.seconds === 2 && !spec.base)).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(looks.getSnapshot()).toEqual({ kind: "idle" });
  });

  it("say for each side whether it failed, and why", async () => {
    let calls = 0;
    const { looks } = setUp({
      compositor: () => ({
        look: async () => {
          calls += 1;
          if (calls === 1) throw new StillFailed({ reason: "missing-file", layer: "c", file: "h" });
          return { image: new Blob(["jpeg"]), width: 320, height: 180, texts: [] };
        },
        dispose: () => {},
      }),
    });
    const state = openStore().getState();
    const answer = await looks.pictures({
      before: state,
      after: state,
      timeline: "main",
      seconds: 1,
      side: 320,
    });
    expect(answer.before).toEqual({
      ok: false,
      failure: { reason: "missing-file", layer: "c", file: "h" },
    });
    expect(answer.after).toMatchObject({ ok: true, width: 320 });
    expect(
      await looks.pictures({
        before: state,
        after: state,
        timeline: "nope",
        seconds: 1,
        side: 320,
      }),
    ).toMatchObject({ before: { ok: false, failure: { reason: "failed" } } });
  });
});
