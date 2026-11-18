import { buildMixPlan, orderedTracks, type CommandFailure } from "@animaquill/core";
import { CLIP_SOUND, type PropertySpec } from "@animaquill/schema";
import { describe, expect, it, vi } from "vitest";
import { KeyframeEditor } from "../keyframes/editor.ts";
import { writeEdit } from "../properties/inspect.ts";
import { PropertyRows } from "../properties/rows.ts";
import { TrialSession } from "../properties/trial.ts";
import { PropertyWriter } from "../properties/writer.ts";
import { TimelineEditor } from "../timeline/editor.ts";
import {
  MemoryLibrary,
  MemoryTrials,
  memoryAddress,
  memoryWindow,
} from "../workbench/memory-library.ts";
import { ProjectSession } from "../workbench/session.ts";
import { trackClipId, triedApart, withTrackClips } from "./track-clip.ts";

/**
 * A track of sound as the mixer, the properties and the keyframes have it: selected instead of
 * clips, its volume and pan written to the track as one step, keys on the timeline's time.
 */

const [VOLUME, PAN] = CLIP_SOUND.properties as [PropertySpec, PropertySpec];
const t = ((key: string) => key) as never;

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
  await session.create("混音");
  const store = session.store;
  if (!store) throw new Error("no project");
  const settings = {
    load: async (key: string) => (key === "trial" ? { version: 1, enabled: trying } : undefined),
    save: async () => {},
    listen: () => () => {},
  };
  const commandFailed = vi.fn<(failure: CommandFailure) => void>();
  const memory = memoryWindow();
  const timeline = new TimelineEditor(session, memory, settings, { commandFailed });
  await timeline.load();
  timeline.setViewport(1000, 400);
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
  const writer = new PropertyWriter(session, timeline, trials, {
    commandFailed,
    comparing: vi.fn(),
  });
  const keyframes = new KeyframeEditor(session, timeline, trials, writer, memory, settings, t, {
    pasteTooEarly: vi.fn(),
    pasteNowhere: vi.fn(),
    comparing: vi.fn(),
    locked: vi.fn(),
    notShown: vi.fn(),
    gone: vi.fn(),
  });
  const main = () => store.getState().timelines["main"] as NonNullable<unknown> as never;
  const tracks = orderedTracks(main());
  const audio = tracks.find(({ kind }) => kind === "audio")?.id as string;
  const video = tracks.find(({ kind }) => kind === "video")?.id as string;
  // Something on the timeline, so that it is ten seconds long.
  store.execute({
    type: "clip.add",
    params: {
      timeline: "main",
      track: video,
      id: "c",
      start: "0",
      duration: "10",
      source: { kind: "color", color: "#ff0000" },
    },
  });
  const rows = new PropertyRows({
    timeline: {
      get model() {
        const model = timeline.getSnapshot().model;
        return model && withTrackClips(model);
      },
      get frame() {
        return timeline.frame;
      },
      subscribe: timeline.subscribe,
      subscribeView: timeline.subscribeView,
    },
    trials,
    state: () => store.getState(),
  });
  const clip = trackClipId(audio);
  /** What the fader or the knob writes at the playhead. */
  const edit = (spec: PropertySpec, value: number) => {
    const now = rows.inspect(clip, spec);
    if (!now) throw new Error("no track");
    return writeEdit(clip, now.row, now.time, value);
  };
  const property = (path: string) => {
    const track = store.getState().timelines["main"]?.tracks[audio];
    return track?.kind === "audio" ? (track.properties?.[path] as unknown) : undefined;
  };
  const fps = timeline.model?.rate.fps ?? 30;
  return {
    store,
    timeline,
    trials,
    writer,
    keyframes,
    rows,
    audio,
    video,
    clip,
    edit,
    property,
    fps,
    commandFailed,
  };
}

describe("selecting a track", () => {
  it("selects a track of sound instead of clips, and a clip instead of it", async () => {
    const { timeline, audio, video } = await setup();
    timeline.selectOnly("c");
    timeline.selectTrack(audio);
    expect(timeline.getSnapshot().track).toBe(audio);
    expect(timeline.getSnapshot().selection.size).toBe(0);
    timeline.selectOnly("c");
    expect(timeline.getSnapshot().track).toBeUndefined();
    // A track of pictures has no volume to show.
    timeline.selectTrack(video);
    expect(timeline.getSnapshot().track).toBeUndefined();
    timeline.selectTrack(audio);
    timeline.clearSelection();
    expect(timeline.getSnapshot().track).toBeUndefined();
  });

  it("lists the volume and pan of a selected track in the keyframes, on top of its clips", async () => {
    const { timeline, keyframes, audio, clip } = await setup();
    const listed = () =>
      keyframes
        .tracks(keyframes.model as never)
        .find((node) => node.track === audio)
        ?.children.map((node) => node.clip) ?? [];
    expect(listed()).toEqual([]);
    timeline.selectTrack(audio);
    expect(listed()).toEqual([clip]);
    const model = keyframes.model;
    expect(model?.boxes.get(clip)?.start).toBe(0);
    expect(keyframes.nameOfNode({ kind: "clip", id: "x", clip, children: [] })).toBe(
      "mixer.trackItself",
    );
    timeline.selectOnly("c");
    expect(listed()).toEqual([]);
  });
});

describe("writing the volume and pan of a track", () => {
  it("hears a fader while it moves and writes it to the track as one step", async () => {
    const { store, writer, edit, audio, clip, property } = await setup();
    writer.preview([edit(VOLUME, -6)]);
    expect(writer.getPreviewed().get(clip)?.get("audio.volume")).toBe(-6);
    const { tracks } = triedApart(writer.getPreviewed());
    expect(tracks.get(audio)?.get("audio.volume")).toBe(-6);
    // The mix hears it before it is written.
    const state = store.getState();
    const tried = triedApart(writer.getPreviewed());
    const plan = buildMixPlan(state, "main", tried.clips, tried.tracks);
    expect(plan.tracks.find(({ id }) => id === audio)?.gain).toBeCloseTo(10 ** (-6 / 20), 9);
    expect(property("audio.volume")).toBeUndefined();
    const { revision } = store;
    expect(writer.commit([edit(VOLUME, -6)])).toBe(true);
    expect(property("audio.volume")).toBe(-6);
    expect(store.revision).toBe(revision + 1);
    writer.commit([edit(PAN, -0.5)]);
    expect(property("audio.pan")).toBe(-0.5);
    store.undo();
    store.undo();
    expect(property("audio.volume")).toBeUndefined();
  });

  it("writes a track at once also while trying things out first", async () => {
    const { writer, edit, property, trials } = await setup({ trying: true });
    expect(trials.takesEdits).toBe(true);
    expect(writer.commit([edit(VOLUME, -3)])).toBe(true);
    expect(property("audio.volume")).toBe(-3);
  });

  it("records keys on the timeline's time with automatic keys on, and follows the playhead", async () => {
    const { timeline, writer, edit, property, rows, clip, fps } = await setup();
    writer.setRecording(true);
    timeline.seek(2 * fps);
    writer.commit([edit(VOLUME, -12)]);
    expect(property("audio.volume")).toEqual({
      keys: [
        { time: "0", value: 0 },
        { time: "2", value: -12 },
      ],
    });
    // The fader goes with the playhead: what the keys come to there.
    timeline.seek(0);
    expect(rows.inspect(clip, VOLUME)?.row.value).toBe(0);
    timeline.seek(2 * fps);
    expect(rows.inspect(clip, VOLUME)?.row.value).toBe(-12);
    timeline.seek(fps);
    expect(rows.inspect(clip, VOLUME)?.row.value).toBeCloseTo(-6, 6);
    // With keys, a fader writes a key where the playhead is.
    writer.setRecording(false);
    timeline.seek(4 * fps);
    writer.commit([edit(VOLUME, -3)]);
    expect(property("audio.volume")).toMatchObject({ keys: [{}, {}, { time: "4", value: -3 }] });
  });

  it("cannot change a locked track", async () => {
    const { timeline, rows, clip, audio } = await setup();
    timeline.updateTrack(audio, { locked: true });
    expect(rows.inspect(clip, VOLUME)?.blocked).toBe("locked");
  });
});
