import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { USER } from "../origin.ts";
import { ProjectStore } from "../store.ts";
import { REFERENCE_CODES, referenceProblems } from "./references.ts";
import { staticProblems } from "./static.ts";
import { TONE, audio, clip, stateOf, video } from "./test-support.ts";

/** Each problem in a line: code, the clip, its parameters. */
const said = (problems: ReturnType<typeof referenceProblems>) =>
  problems.map(({ code, subject, params }) =>
    [code, subject?.id, JSON.stringify(Object.fromEntries(Object.entries(params).toSorted()))].join(
      " ",
    ),
  );

describe("clips that use what the project does not have", () => {
  it("are a problem of each clip, by the kind of what is missing", () => {
    const state = stateOf({
      tracks: [
        video([
          clip("picture", { kind: "image", media: { asset: "logo_typo" } }),
          clip("card", { kind: "scene", scene: "gone" }, { start: "5" }),
        ]),
        audio([clip("hit", { kind: "sound", sound: "gone_too" })]),
      ],
    });
    expect(said(referenceProblems(state)).toSorted()).toEqual(
      [
        'asset-missing picture {"asset":"logo_typo"}',
        'scene-missing card {"scene":"gone"}',
        'sound-missing hit {"sound":"gone_too"}',
      ].toSorted(),
    );
    const codes = new Set(referenceProblems(state).map(({ code }) => code));
    expect(REFERENCE_CODES.filter((code) => !codes.has(code))).toEqual([]);
    // They are of what the project alone tells, wherever problems are shown.
    const all = staticProblems(state).map(({ code }) => code);
    expect(all).toEqual(expect.arrayContaining([...REFERENCE_CODES]));
  });

  it("are nothing where everything is there, as in the example project", () => {
    expect(
      referenceProblems(stateOf({ tracks: [audio([clip("t", TONE_SOURCE)])], assets: TONE })),
    ).toEqual([]);
    const { store } = ProjectStore.open(loadFixture("v1"));
    expect(referenceProblems(store?.getState() as never)).toEqual([]);
  });

  it("come with a clip that people put on an asset that is not there, which the command takes", () => {
    // The example without the tag that locks it.
    const files = loadFixture("v1");
    const manifest = JSON.parse(files.get("animaquill.json") as string);
    delete manifest.tags;
    files.set("animaquill.json", JSON.stringify(manifest));
    const store = ProjectStore.open(files).store as ProjectStore;
    const before = referenceProblems(store.getState()).length;
    const done = store.execute(
      {
        type: "clip.add",
        params: {
          timeline: "main",
          track: "track_video",
          id: "pasted",
          start: "31",
          duration: "2",
          source: { kind: "image", media: { asset: "from_another_project" } },
        },
      },
      { origin: USER },
    );
    expect(done.ok).toBe(true);
    const after = said(referenceProblems(store.getState()));
    expect(after.length).toBe(before + 1);
    expect(after).toContain('asset-missing pasted {"asset":"from_another_project"}');
  });
});

const TONE_SOURCE = { kind: "audio", media: { asset: "tone" } } as const;
