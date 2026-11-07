import {
  ProjectStore,
  clipNodeOf,
  orderedTracks,
  type PropertyNode,
  type TimelineState,
  type TrackNode,
  type TreeNode,
} from "@animaquill/core";
import { createProject, type ObjectDescriptor, type PropertySpec } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import { buildModel } from "../timeline/model.ts";
import { LANE_HEIGHT, firstLaneBelow, laneAt, lanesOfClip, lanesOfTracks } from "./lanes.ts";

const number = (path: string): PropertySpec => ({ path, type: "number" });

const OBJECTS: readonly ObjectDescriptor[] = [
  { id: "rig", name: "骨架", properties: [number("object.rig.x")] },
  { id: "arm", parent: "rig", properties: [number("object.arm.r")] },
  { id: "hand", parent: "arm", properties: [{ ...number("object.hand.r"), group: "turn" }] },
];

function setup() {
  const store = ProjectStore.create(createProject({ name: "车道" }));
  const main = () => store.getState().timelines["main"] as TimelineState;
  const track = orderedTracks(main()).find(({ kind }) => kind === "video")?.id as string;
  const source = { kind: "color", color: "#000000" };
  const clip = { id: "c", start: "1", duration: "2", source };
  store.execute({ type: "clip.add", params: { timeline: "main", track, clip } });
  const model = buildModel("main", main(), "30");
  const box = model.boxes.get("c");
  const row = model.rows.find(({ id }) => id === track);
  if (!box || !row) throw new Error("no clip");
  const node = clipNodeOf(box.clip, OBJECTS);
  const tracks: readonly TrackNode[] = [
    { kind: "track", id: `track:${track}`, track, children: [node] },
  ];
  return { model, box, row, node, tracks };
}

const allOpen = {
  isOpen: () => true,
  curveHeight: (_node: PropertyNode) => undefined,
};

describe("lanes of a tree", () => {
  it("go as deep as objects do, one under the other", () => {
    const { model, tracks } = setup();
    const lanes = lanesOfTracks(model, tracks, allOpen);
    expect(lanes.map(({ node, depth }) => [node.kind, depth])).toEqual([
      ["track", 0],
      ["clip", 1],
      ["object", 2],
      ["property", 3],
      ["object", 3],
      ["property", 4],
      ["object", 4],
      ["group", 5],
      ["property", 6],
    ]);
    expect(lanes.map(({ top }) => top)).toEqual(lanes.map((_, index) => index * LANE_HEIGHT));
  });

  it("know the clip they are about, and what is below them", () => {
    const { model, box, tracks } = setup();
    const lanes = lanesOfTracks(model, tracks, allOpen);
    expect(lanes[0]?.box).toBeUndefined();
    for (const lane of lanes.slice(1)) expect(lane.box).toBe(box);
    expect(lanes[0]?.listed.get("c")).toEqual(["object.rig.x", "object.arm.r", "object.hand.r"]);
    expect(lanes[4]?.listed.get("c")).toEqual(["object.arm.r", "object.hand.r"]);
    expect(lanes[5]?.listed.get("c")).toEqual(["object.arm.r"]);
  });

  it("leave out what is below something closed", () => {
    const { model, tracks } = setup();
    const isOpen = (node: TreeNode) => node.kind === "track" || node.kind === "clip";
    const lanes = lanesOfTracks(model, tracks, { ...allOpen, isOpen });
    expect(lanes.map(({ node }) => node.kind)).toEqual(["track", "clip", "object"]);
    expect(lanes[2]?.canOpen).toBe(true);
    expect(lanes[2]?.open).toBe(false);
  });

  it("say which group a property is in", () => {
    const { model, tracks } = setup();
    const lanes = lanesOfTracks(model, tracks, allOpen);
    expect(lanes.at(-1)?.group).toBe("turn");
    expect(lanes[3]?.group).toBeUndefined();
  });

  it("make room for a curve, and only for what can have one", () => {
    const { model, tracks } = setup();
    const lanes = lanesOfTracks(model, tracks, { ...allOpen, curveHeight: () => 50 });
    expect(lanes[3]?.height).toBe(LANE_HEIGHT + 50);
    expect(lanes[4]?.top).toBe((lanes[3]?.top ?? 0) + LANE_HEIGHT + 50);
    expect(lanes[2]?.height).toBe(LANE_HEIGHT);
  });

  it("of one clip start where they are told to", () => {
    const { model, node, row } = setup();
    const lanes = lanesOfClip(model, node, row, 500, allOpen);
    expect(lanes[0]?.top).toBe(500);
    expect(lanes[0]?.depth).toBe(0);
    expect(lanes[0]?.node.kind).toBe("clip");
  });

  it("can be found by height", () => {
    const { model, tracks } = setup();
    const lanes = lanesOfTracks(model, tracks, { ...allOpen, curveHeight: () => 50 });
    expect(laneAt(lanes, 0)).toBe(lanes[0]);
    expect(laneAt(lanes, LANE_HEIGHT * 3 + 40)).toBe(lanes[3]);
    expect(laneAt(lanes, -1)).toBeUndefined();
    expect(laneAt(lanes, 100_000)).toBeUndefined();
    expect(firstLaneBelow(lanes, -5)).toBe(0);
    expect(firstLaneBelow(lanes, LANE_HEIGHT)).toBe(1);
    expect(firstLaneBelow(lanes, LANE_HEIGHT - 1)).toBe(0);
    expect(firstLaneBelow(lanes, 100_000)).toBe(lanes.length);
  });

  it("do not go wrong on a track that is not there any more", () => {
    const { model, tracks } = setup();
    const gone = [{ ...(tracks[0] as TrackNode), track: "nothing" }];
    expect(lanesOfTracks(model, gone, allOpen)).toEqual([]);
  });
});
