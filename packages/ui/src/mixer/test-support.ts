import { orderedTracks, type CommandFailure } from "@animaquill/core";
import type { PropertySpec } from "@animaquill/schema";
import { vi } from "vitest";
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
import { trackClipId, withTrackClips } from "./track-clip.ts";

/** A project with a track of sound and the editors around it, for tests of the mixer. */

const t = ((key: string) => key) as never;

export async function setup({ trying = false } = {}) {
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
