import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import type { ProjectState } from "../model.ts";
import { ProjectStore } from "../store.ts";
import { outputProblems } from "./static.ts";
import {
  TONE,
  audio,
  captions,
  clip,
  color,
  stateOf,
  tone,
  video,
  type Setup,
} from "./test-support.ts";
import { UNSUPPORTED_CODES, unsupportedProblems } from "./unsupported.ts";

const problemsOf = (setup: Setup) => unsupportedProblems(stateOf(setup));
/** Each problem in a line: code, what it is about, its parameters, and what it does to an export. */
const said = (setup: Setup) =>
  problemsOf(setup).map(({ code, subject, params, affectsOutput }) =>
    [
      code,
      subject?.id,
      JSON.stringify(Object.fromEntries(Object.entries(params).toSorted())),
      affectsOutput ?? "-",
    ].join(" "),
  );

const keys = (...values: readonly number[]) => ({
  keys: values.map((value, index) => ({ time: String(index), value })),
});

function example(): ProjectState {
  const state = ProjectStore.open(loadFixture("v1")).store?.getState();
  if (!state) throw new Error("The example did not open");
  return state;
}

describe("what this editor does not do yet", () => {
  it("is all there in the example project, which uses every part of the format", () => {
    const state = example();
    // The example has no notes in music/, so it gets a clip of them here.
    const highlight = state.timelines["highlight"] as ProjectState["timelines"][string];
    const music = {
      id: "m",
      track: "music",
      start: "0",
      duration: "1",
      source: { kind: "music", music: "x" },
    };
    const withMusic = {
      ...state,
      timelines: {
        ...state.timelines,
        highlight: {
          ...highlight,
          clips: { ...highlight.clips, m: music },
          tracks: { ...highlight.tracks, music: { id: "music", kind: "audio", order: 9 } },
        },
      },
    } as ProjectState;
    const codes = new Set(unsupportedProblems(withMusic).map(({ code }) => code));
    expect(UNSUPPORTED_CODES.filter((code) => !codes.has(code))).toEqual([]);
  });

  it("is nothing in a project that uses none of it", () => {
    const setup = {
      tracks: [
        video([color("red", { properties: { "time.speed": 1, opacity: 0.5 } })]),
        audio([tone("tone", { properties: { "audio.volume": -6, "audio.pan": 0 } })]),
      ],
      assets: TONE,
    };
    expect(said(setup)).toEqual([]);
  });

  it("says which clips are notes of music, which are silent", () => {
    const music = clip("m", { kind: "music", music: "theme" });
    expect(said({ tracks: [video([]), audio([music])] })).toEqual([
      "unsupported-music-clip m {} sound",
    ]);
    // A muted track has nothing to say in an export, but the clip is still not heard.
    expect(said({ tracks: [video([]), audio([music], { muted: true })] })).toEqual([
      "unsupported-music-clip m {} -",
    ]);
    expect(said({ tracks: [video([]), audio([tone("t")])], assets: TONE })).toEqual([]);
  });

  it("says which clips are timelines, which do not show", () => {
    const nested = clip("n", { kind: "timeline", timeline: "main" });
    expect(said({ tracks: [video([nested])] })).toEqual([
      'unsupported-timeline-clip n {"timeline":"main"} picture',
    ]);
    expect(said({ tracks: [video([color("red")])] })).toEqual([]);
  });

  it("says what comes from a library, whichever way it does", () => {
    const fromLibrary = { library: "lib", path: "a.png" };
    const setup = {
      tracks: [
        video(
          [
            clip("image", { kind: "image", media: fromLibrary }),
            clip("scene", { kind: "scene", library: "lib", resource: "card" }, { start: "5" }),
            color("enter", {
              start: "10",
              enter: { library: "lib", resource: "wipe", duration: "1" },
            }),
            clip(
              "value",
              { kind: "scene", scene: "s" },
              {
                start: "15",
                properties: { "param.logo": { keys: [{ time: "0", value: fromLibrary }] } },
              },
            ),
            color("before", { start: "20" }),
            color("after", { start: "25" }),
          ],
          {
            joins: [
              {
                id: "j",
                from: "before",
                to: "after",
                library: "lib",
                resource: "ink",
                duration: "1",
              },
            ],
          },
        ),
      ],
    };
    expect(said(setup).toSorted()).toEqual(
      [
        'unsupported-library image {"library":"lib"} picture',
        'unsupported-library scene {"library":"lib"} picture',
        'unsupported-library enter {"library":"lib"} picture',
        'unsupported-library value {"library":"lib"} picture',
        'unsupported-library before {"library":"lib"} picture',
      ].toSorted(),
    );
    const own = clip("own", { kind: "image", media: { asset: "logo" } });
    expect(said({ tracks: [video([own])] })).toEqual([]);
  });

  it("says once for a track of captions that they are not drawn", () => {
    const line = (id: string, start: string) =>
      clip(id, { kind: "caption", text: "字" }, { start, duration: "2" });
    expect(said({ tracks: [video([]), captions([line("a", "0"), line("b", "3")])] })).toEqual([
      'unsupported-caption-display c {"count":2} picture',
    ]);
    expect(said({ tracks: [video([]), captions([line("a", "0")], { hidden: true })] })).toEqual([
      'unsupported-caption-display c {"count":1} -',
    ]);
    expect(said({ tracks: [video([]), captions([])] })).toEqual([]);
  });

  it("says where effects on sound are, and a mix", () => {
    const effect = { id: "fx", type: "reverb" };
    expect(
      said({ tracks: [video([]), audio([tone("t", { effects: [effect] })])], assets: TONE }),
    ).toEqual(['unsupported-audio-effect t {"count":1,"where":"clip"} sound']);
    expect(said({ tracks: [video([]), audio([], { effects: [effect] })] })).toEqual([
      'unsupported-audio-effect a {"count":1,"where":"track"} sound',
    ]);
    const mix = { buses: [{ id: "bus" }] };
    expect(said({ tracks: [video([]), audio([])], mix })).toEqual([
      'unsupported-audio-effect main {"count":1,"where":"mix"} sound',
    ]);
    const limiter = { master: { effects: [{ id: "limit", type: "limiter" }] } };
    expect(said({ tracks: [video([]), audio([])], mix: limiter })).toHaveLength(1);
    // Off, an effect does nothing; on a picture, it is one that this editor does.
    const off = { ...effect, enabled: false };
    expect(
      said({ tracks: [video([]), audio([tone("t", { effects: [off] })])], assets: TONE }),
    ).toEqual([]);
    const blur = { id: "fx", type: "blur" };
    expect(said({ tracks: [video([color("red", { effects: [blur] })])] })).toEqual([]);
    expect(said({ tracks: [video([]), audio([])], mix: {} })).toEqual([]);
  });

  it("says which properties of sound and speed would change what is heard or seen", () => {
    const heard = (properties: object) =>
      said({ tracks: [video([]), audio([tone("t", { properties })])], assets: TONE });
    expect(heard({ "audio.pan": 0.3 })).toEqual([
      'unsupported-audio-property t {"property":"audio.pan"} sound',
    ]);
    expect(heard({ "audio.pitch": keys(0, 2) })).toEqual([
      'unsupported-audio-property t {"property":"audio.pitch"} sound',
    ]);
    expect(heard({ "audio.pan": 0, "audio.pitch": keys(0, 0), "time.speed": 1 })).toEqual([]);
    // Keeping the pitch is a choice that only matters while the speed changes.
    expect(heard({ "audio.preservePitch": true })).toEqual([
      'unsupported-audio-property t {"property":"audio.preservePitch"} -',
    ]);
    expect(heard({ "audio.preservePitch": true, "time.speed": 2 }).toSorted()).toEqual(
      [
        'unsupported-audio-property t {"property":"audio.preservePitch"} sound',
        'unsupported-audio-property t {"property":"time.speed"} sound',
      ].toSorted(),
    );
    const film = clip(
      "film",
      { kind: "video", media: { asset: "film" } },
      {
        properties: { "time.speed": keys(1, 0.5) },
      },
    );
    expect(said({ tracks: [video([film])] })).toEqual([
      'unsupported-audio-property film {"property":"time.speed"} picture',
    ]);
    // Neither a picture that does not move nor a clip that makes no sound has any of that.
    const still = color("red", { properties: { "time.speed": 2, "audio.pan": 1 } });
    expect(said({ tracks: [video([still])] })).toEqual([]);
    expect(said({ tracks: [video([]), audio([], { properties: { "audio.pan": -1 } })] })).toEqual([
      'unsupported-audio-property a {"property":"audio.pan"} sound',
    ]);
  });

  it("says where the volume has keys, of which only the first counts", () => {
    const heard = (volume: unknown) =>
      said({
        tracks: [video([]), audio([tone("t", { properties: { "audio.volume": volume } })])],
        assets: TONE,
      });
    expect(heard(keys(-12, -30))).toEqual(["unsupported-volume-keys t {} sound"]);
    expect(heard(keys(-6, -6))).toEqual([]);
    expect(heard(-6)).toEqual([]);
    expect(
      said({ tracks: [video([]), audio([], { properties: { "audio.volume": keys(0, -6) } })] }),
    ).toEqual(["unsupported-volume-keys a {} sound"]);
  });

  it("says where a loop would repeat something", () => {
    const looped = (more: object, assets: Setup["assets"] = TONE) =>
      said({ tracks: [video([]), audio([tone("t", { loop: true, ...more })])], assets });
    // The tone is 10 seconds long.
    expect(looped({ duration: "5" })).toEqual([]);
    expect(looped({ duration: "8", offset: "3" })).toEqual(["unsupported-loop t {} sound"]);
    expect(looped({ duration: "12" })).toEqual(["unsupported-loop t {} sound"]);
    // Without a length that is known, it may well.
    const unknown = {
      tone: { kind: "audio" as const, path: "assets/tone.wav", storage: "git" as const },
    };
    expect(looped({ duration: "5" }, unknown)).toEqual(["unsupported-loop t {} sound"]);
    expect(said({ tracks: [video([color("red", { loop: true })])] })).toEqual([]);
  });

  it("says which clips are drafts, which an export still has", () => {
    expect(said({ tracks: [video([color("idea", { draft: true })])] })).toEqual([
      "unsupported-draft idea {} picture",
    ]);
    expect(said({ tracks: [video([color("idea", { draft: true, hidden: true })])] })).toEqual([
      "unsupported-draft idea {} -",
    ]);
    expect(said({ tracks: [video([color("idea", { draft: false })])] })).toEqual([]);
  });

  it("says which versions there are, which only the one of a format changes an export of", () => {
    const formats = [
      { id: "landscape", name: "横屏", width: 1920, height: 1080, fps: "30" },
      { id: "portrait", name: "竖屏", width: 1080, height: 1920, fps: "30" },
    ];
    const hide = { red: { hidden: { value: true } } };
    const setup = (overrides: Record<string, unknown>) =>
      said({ tracks: [video([color("red")])], formats, overrides });
    expect(setup({ "format.portrait": { scope: { format: "portrait" }, clips: hide } })).toEqual([
      'unsupported-override main {"format":"portrait","name":"format.portrait"} both',
    ]);
    expect(setup({ "language.zh-CN": { scope: { language: "zh-CN" }, clips: hide } })).toEqual([
      'unsupported-override main {"language":"zh-CN","name":"language.zh-CN"} -',
    ]);
    expect(setup({ "format.portrait": { scope: { format: "portrait" } } })).toEqual([]);
  });
});

describe("what makes an export otherwise than the project", () => {
  const formats = [
    { id: "landscape", name: "横屏", width: 1920, height: 1080, fps: "30" },
    { id: "portrait", name: "竖屏", width: 1080, height: 1920, fps: "30" },
  ];
  const state = stateOf({
    tracks: [
      video([color("early", { draft: true }), color("late", { start: "20", draft: true })]),
      audio([tone("pan", { properties: { "audio.pan": 1 } })]),
    ],
    assets: TONE,
    formats,
    overrides: {
      "format.portrait": {
        scope: { format: "portrait" },
        clips: { early: { hidden: { value: true } } },
      },
    },
  });
  const all = unsupportedProblems(state);
  const of = (query: Parameters<typeof outputProblems>[2]) =>
    outputProblems(state, all, query)
      .map(({ code, subject }) => `${code} ${subject?.id}`)
      .toSorted();

  it("is all that is in it, and a version only when that is what is exported", () => {
    expect(of({ timeline: "main", part: "both" })).toEqual(
      [
        "unsupported-audio-property pan",
        "unsupported-draft early",
        "unsupported-draft late",
      ].toSorted(),
    );
    expect(of({ timeline: "main", part: "both", format: "portrait" })).toContain(
      "unsupported-override main",
    );
  });

  it("is only what is in its time, and nothing of sound for a picture", () => {
    expect(of({ timeline: "main", part: "both", from: 0, to: 10 })).toEqual(
      ["unsupported-audio-property pan", "unsupported-draft early"].toSorted(),
    );
    expect(of({ timeline: "main", part: "picture", from: 21, to: 21 })).toEqual([
      "unsupported-draft late",
    ]);
    expect(of({ timeline: "other", part: "both" })).toEqual([]);
  });
});
