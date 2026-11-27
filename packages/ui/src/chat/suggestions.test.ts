import { describe, expect, it } from "vitest";
import { suggestionsOf, type ProjectFacts } from "./suggestions.ts";

const facts = (given: Partial<ProjectFacts> = {}): ProjectFacts => ({
  selectedClips: 0,
  problems: 0,
  clips: 3,
  assets: 0,
  playhead: "[0:12](aq://time?timeline=main&t=12)",
  ...given,
});
const keys = (given: Partial<ProjectFacts>) => suggestionsOf(facts(given)).map(({ key }) => key);

describe("what an empty conversation offers to say", () => {
  it("speaks of what is selected first, two ways", () => {
    expect(keys({ selectedClips: 2 })).toEqual(["moveSelected", "fadeSelected", "marker"]);
    expect(suggestionsOf(facts({ selectedClips: 2 }))[0]?.values).toEqual({ count: 2 });
  });

  it("offers to look at the problems, where there are some", () => {
    expect(keys({ problems: 3 })).toEqual(["problems", "marker"]);
  });

  it("offers a first cut of the assets on an empty timeline, else a title scene", () => {
    expect(keys({ clips: 0, assets: 5 })).toEqual(["cutAssets", "marker"]);
    expect(keys({ clips: 0, assets: 0 })).toEqual(["titleScene", "marker"]);
  });

  it("always offers a marker at the playhead, where there is a timeline", () => {
    expect(suggestionsOf(facts()).at(-1)).toEqual({
      key: "marker",
      values: { time: "[0:12](aq://time?timeline=main&t=12)" },
    });
    // Without a timeline: still something to start with.
    expect(keys({ clips: undefined, playhead: undefined })).toEqual(["titleScene"]);
  });

  it("offers four at most, the marker at the playhead always among them", () => {
    expect(keys({ selectedClips: 1, problems: 2, clips: 0, assets: 1 })).toEqual([
      "moveSelected",
      "fadeSelected",
      "problems",
      "marker",
    ]);
  });
});
