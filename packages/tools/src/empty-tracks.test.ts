import { createProject } from "@animaquill/schema";
import { ProjectStore } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import type { Approval, ApproveRequest } from "./approve.ts";
import { testHost, toolsOn } from "./test-support.ts";

/**
 * A track that a batch of AI leaves without clips goes in the same step, as for people (U2): AI is
 * told which, so that it does not use them again, and what people allow shows it.
 */

const COLOR = { kind: "color", color: "#112233" };

/** Video tracks `v1` with `c1` and `v2` with `c2`, and empty tracks cleaned up. */
function project(): ProjectStore {
  const created = createProject({ name: "轨道" });
  const main = created.timelines.get("main")?.document;
  if (!main) throw new Error("no timeline");
  const clip = (id: string) => ({ id, start: "0", duration: "2", source: COLOR });
  const store = ProjectStore.create({
    ...created,
    timelines: new Map([
      [
        "main",
        {
          document: {
            ...main,
            tracks: [
              { id: "v1", kind: "video", clips: [clip("c1")] },
              { id: "v2", kind: "video", clips: [clip("c2")] },
            ],
          } as never,
          overrides: new Map(),
        },
      ],
    ]),
  });
  store.setTidying({ emptyTracks: true });
  return store;
}

const MOVE = {
  operations: [
    { op: "clip.move", timeline: "main", clips: [{ clip: "c2", track: "v1", start: "4" }] },
  ],
  summary: "Moves c2",
};

const tracksOf = (store: ProjectStore) => Object.keys(store.getState().timelines["main"]!.tracks);

describe("aq_edit and the tracks it empties", () => {
  it("says which tracks went, in a dry run and when it writes", async () => {
    const store = project();
    const { call } = toolsOn(testHost(store));
    await call("aq_timeline_read");
    const dry = await call("aq_edit", { ...MOVE, dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.text).toContain("\nremoved empty tracks: v2\n");
    expect(tracksOf(store)).toEqual(["v1", "v2"]);
    const done = await call("aq_edit", MOVE);
    expect(done.isError, done.text).toBe(false);
    expect(done.text).toContain("\nremoved empty tracks: v2\n");
    expect(tracksOf(store)).toEqual(["v1"]);
  });

  it("says nothing of tracks where none went", async () => {
    const store = project();
    store.setTidying({ emptyTracks: false });
    const { call } = toolsOn(testHost(store));
    await call("aq_timeline_read");
    const done = await call("aq_edit", MOVE);
    expect(done.text).not.toContain("removed empty tracks");
    expect(tracksOf(store)).toEqual(["v1", "v2"]);
  });

  it("shows the removal to people who are asked first, and writes what they saw", async () => {
    const store = project();
    const host = testHost(store);
    const asked: { request: ApproveRequest; answer: (approval: Approval) => void }[] = [];
    host.approve = (request) => new Promise((answer) => asked.push({ request, answer }));
    const { call } = toolsOn(host);
    await call("aq_timeline_read");
    const waiting = call("aq_edit", MOVE);
    for (let tries = 0; tries < 100 && asked.length === 0; tries += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [first] = asked;
    if (!first) throw new Error("not asked");
    expect(first.request.after.timelines["main"]?.tracks["v2"]).toBeUndefined();
    expect(first.request.changes.some((change) => change.id === "v2")).toBe(true);
    first.answer("once");
    const result = await waiting;
    expect(result.isError, result.text).toBe(false);
    expect(store.getState()).toEqual(first.request.after);
  });
});
