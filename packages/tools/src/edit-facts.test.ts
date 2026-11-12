import { describe, expect, it } from "vitest";
import { toolsOn } from "./test-support.ts";

/**
 * What aq_edit refuses and says where a model goes wrong without an error otherwise: from the
 * review of 6.5b ⑥ (M1, M2, S2–S7).
 */

describe("aq_edit", () => {
  it("refuses a clip of AI on an asset that the project does not have, naming similar ones", async () => {
    const { call } = toolsOn();
    await call("aq_timeline_read");
    const add = await call("aq_edit", {
      operations: [
        {
          op: "clip.add",
          timeline: "main",
          track: "track_video",
          start: "31",
          duration: "2",
          source: { kind: "image", media: { asset: "logo_typo" } },
        },
      ],
    });
    expect(add.isError).toBe(true);
    expect(add.text).toContain(
      "error not-found in operations[0] (clip.add): There is no asset logo_typo in the project.",
    );
    expect(add.text).toMatch(/similar: logo\b/);
    expect(add.text).toContain("nothing was written");
  });

  it("refuses another source on an asset that the same batch removes", async () => {
    const { call } = toolsOn();
    await call("aq_object_read", { ids: ["clip_idea", "font-sans"] });
    const result = await call("aq_edit", {
      operations: [
        { op: "asset.remove", asset: "font-sans" },
        {
          op: "clip.update",
          timeline: "main",
          clip: "clip_idea",
          changes: { source: { kind: "image", media: { asset: "font-sans" } } },
        },
      ],
    });
    expect(result.text).toMatch(/^error not-found in operations\[1\] \(clip.update\)/);
  });

  it("says the parameters an effect has when one is not", async () => {
    const { call } = toolsOn();
    await call("aq_timeline_read");
    const result = await call("aq_edit", {
      operations: [
        {
          op: "effect.add",
          timeline: "main",
          clip: "clip_logo",
          type: "blur",
          values: { amount: 5 },
        },
      ],
    });
    expect(result.text).toContain("There is no effect parameter amount.");
    expect(result.text).toContain("parameters of blur: radius, edge");
  });

  it("names a value that does not fit once, and says an audio track", async () => {
    const { call, caller } = toolsOn();
    await call("aq_timeline_read");
    const value = await call("aq_edit", {
      operations: [
        {
          op: "property.edit",
          timeline: "main",
          edits: [{ owner: { clip: "clip_title" }, path: "opacity", op: "set", value: 2 }],
        },
      ],
    });
    expect(value.text).toContain("opacity cannot be more than 1.");
    expect(value.text).not.toContain("opacity opacity");
    caller.beginAnswer();
    const effect = await call("aq_edit", {
      operations: [{ op: "effect.add", timeline: "main", clip: "clip_voice", type: "blur" }],
    });
    expect(effect.text).toContain("not on an audio track.");
  });

  it("gives a join without duration the default length of its transition", async () => {
    const { call } = toolsOn();
    await call("aq_timeline_read");
    await call("aq_edit", {
      operations: [
        {
          op: "join.add",
          timeline: "main",
          id: "join_x",
          from: "clip_interview",
          to: "clip_logo",
          type: "dip",
        },
      ],
    });
    const read = await call("aq_object_read", { ids: ["join_x"] });
    expect(read.text).toContain('"duration":"0.5"');
  });

  it("says where a moved track is, by the track in front of it, not by a number", async () => {
    const { call, caller } = toolsOn();
    await call("aq_timeline_read");
    const behind = await call("aq_edit", {
      operations: [
        { op: "track.move", timeline: "main", track: "track_captions", before: "track_video" },
      ],
    });
    expect(behind.text).toContain(
      'track_captions "字幕": position in front of all→behind track_video',
    );
    expect(behind.text).not.toMatch(/order -?\d/);
    caller.beginAnswer();
    const front = await call("aq_edit", {
      operations: [{ op: "track.move", timeline: "main", track: "track_captions" }],
    });
    expect(front.text).toContain("position behind track_video→in front of all");
  });

  it("tells apart a clip of a library and its join of the same library", async () => {
    const { call } = toolsOn();
    const result = await call("aq_check_run", { subject: "clip_logo" });
    const lines = result.text.split("\n").filter((line) => line.includes("unsupported-library"));
    expect(lines).toHaveLength(2);
    expect(new Set(lines).size).toBe(2);
    expect(result.text).toContain("its join join_2 is a transition of library lib_7f3a");
  });
});

describe("the page of an operation", () => {
  it("says a parameter once where the manual goes on from the words of the schema", async () => {
    const { call } = toolsOn();
    const page = (await call("aq_guide", { topic: "ops/clip.split" })).text;
    expect(page).toContain(
      "- keep (list of string, optional): Linked clip ids that stay whole and keep their link.",
    );
    expect(page).not.toContain("stay whole. Linked");
  });
});
