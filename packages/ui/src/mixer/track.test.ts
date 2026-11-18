import { buildMixPlan } from "@animaquill/core";
import { CLIP_SOUND, type PropertySpec } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { setup } from "./test-support.ts";
import { triedApart } from "./track-clip.ts";

/**
 * A track of sound as the mixer, the properties and the keyframes have it: selected instead of
 * clips, its volume and pan written to the track as one step, keys on the timeline's time.
 */

const [VOLUME, PAN] = CLIP_SOUND.properties as [PropertySpec, PropertySpec];

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
