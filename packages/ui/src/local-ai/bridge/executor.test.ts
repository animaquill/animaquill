import { ProblemSet, aiTask, type ProjectStore } from "@animaquill/core";
import { describe, expect, it } from "vitest";
import {
  openUnlocked,
  randomCommand,
  randomFrom,
  seedIds,
} from "../../../../core/src/fuzz-support.ts";
import { BATCH_GAP_MS, BridgeExecutor, type BridgeCall, type BridgeWrite } from "./executor.ts";

/**
 * The calls of AI tools on this computer as the editor runs them (docs/design/online-offline.md of
 * AnimaQuill Cloud, 5): the tools of the browser on the open project, each session with what it
 * read and its own batches, a call that comes again answered once.
 */

function executorOn(store: ProjectStore, options: { hidden?: boolean; now?: () => number } = {}) {
  const problems = new ProblemSet();
  const writes: BridgeWrite[] = [];
  const executor = new BridgeExecutor({
    store: () => store,
    parts: {
      problems: () => {
        problems.update(store.getState());
        return problems;
      },
    },
    hidden: () => options.hidden === true,
    picture: async () => undefined,
    wrote: (write) => writes.push(write),
    ...(options.now && { now: options.now }),
  });
  return { executor, writes };
}

let calls = 0;
const callOf = (
  session: string,
  tool: string,
  args: unknown,
  answer = String(++calls),
): BridgeCall => ({
  call: `${session}-${++calls}`,
  session,
  client: { name: session === "a" ? "claude-code" : "codex" },
  answer,
  tool,
  args,
});

/** A track of the main timeline that takes scenes, whichever is there now. */
const trackOf = (store: ProjectStore) =>
  Object.values(store.getState().timelines.main?.tracks ?? {}).find(
    (track) => (track as { kind?: string }).kind === "video",
  )?.id ?? "track_video";

let tracks: ProjectStore | undefined;

const addClip = (id: string, start: number) => ({
  operations: [
    {
      op: "clip.add",
      timeline: "main",
      track: tracks ? trackOf(tracks) : "track_video",
      id,
      start: String(start),
      duration: "1",
      source: { kind: "scene", scene: "title" },
    },
  ],
});

describe("the calls of AI tools in the editor", () => {
  it("change the project as a batch of each session, which goes back as a whole", async () => {
    const store = openUnlocked();
    let now = 1_000;
    const { executor, writes } = executorOn(store, { now: () => now });
    await executor.run(callOf("a", "aq_timeline_read", { timeline: "main" }));
    const added = await executor.run(callOf("a", "aq_edit", addClip("clip_a1", 40)));
    expect(added.isError, added.text).toBe(false);
    expect(writes.map(({ origin }) => origin)).toEqual([aiTask("mcp-a-1")]);
    // Ten minutes on, a batch of its own.
    now += BATCH_GAP_MS + 1;
    await executor.run(callOf("a", "aq_edit", addClip("clip_a2", 45)));
    expect(writes.map(({ origin }) => origin)).toEqual([aiTask("mcp-a-1"), aiTask("mcp-a-2")]);
    expect(store.undoOrigin(aiTask("mcp-a-1")).ok).toBe(true);
    const clips = store.getState().timelines.main?.clips ?? {};
    expect(clips.clip_a1).toBeUndefined();
    expect(clips.clip_a2).toBeDefined();
    store.destroy();
  });

  it("answer a call that comes again with what it got, without running it twice", async () => {
    const store = openUnlocked();
    const { executor, writes } = executorOn(store);
    await executor.run(callOf("a", "aq_timeline_read", { timeline: "main" }));
    const call = callOf("a", "aq_edit", addClip("clip_once", 40));
    const first = await executor.run(call);
    const again = await executor.run(call);
    expect(again).toEqual(first);
    expect(writes).toHaveLength(1);
    store.destroy();
  });

  it("say the editor is in the background for frames, and nothing else", async () => {
    const store = openUnlocked();
    const { executor } = executorOn(store, { hidden: true });
    const frames = await executor.run(
      callOf("a", "aq_render_frames", { timeline: "main", times: ["0"] }),
    );
    expect(frames.isError).toBe(true);
    expect(frames.text).toMatch(/^error editor-hidden: /);
    const read = await executor.run(callOf("a", "aq_timeline_read", { timeline: "main" }));
    expect(read.isError).toBe(false);
    store.destroy();
  });

  it("keep what each session read apart: one that read nothing may change nothing", async () => {
    const store = openUnlocked();
    const { executor } = executorOn(store);
    await executor.run(callOf("a", "aq_timeline_read", { timeline: "main" }));
    const [clip] = Object.keys(store.getState().timelines.main?.clips ?? {});
    const update = {
      operations: [{ op: "clip.update", timeline: "main", clip, changes: { name: "改过" } }],
    };
    const unread = await executor.run(callOf("b", "aq_edit", update));
    expect(unread.isError).toBe(true);
    expect(unread.text).toMatch(/not-read/);
    store.destroy();
  });
});

describe("two AI tools and people changing one project at once", () => {
  it("each AI change is its own session's, and goes back without what the others did", async () => {
    const ROUNDS = 200;
    seedIds(7);
    const random = randomFrom(20_261_123);
    const store = openUnlocked();
    tracks = store;
    const { executor } = executorOn(store);
    const made = { a: new Set<string>(), b: new Set<string>(), you: new Set<string>() };
    const counted = { ok: 0, refused: 0, again: 0, people: 0 };
    const sent: BridgeCall[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const who = random.pick(["a", "b", "you"] as const) ?? "a";

      if (who === "you") {
        // Anything the editor's commands do but take a whole track away with what AI put there.
        let command = randomCommand(store, random);
        while (command.type === "track.remove") command = randomCommand(store, random);
        const done = store.execute(command, {});
        if (done.ok) counted.people += 1;
        // And a clip of their own now and then, which no AI takes away.
        const id = `clip_you${round}`;
        const added = store.execute({
          type: "clip.add",
          params: {
            timeline: "main",
            track: trackOf(store),
            id,
            start: String(100 + round),
            duration: "1",
            source: { kind: "scene", scene: "title" },
          },
        });
        if (added.ok) made.you.add(id);
        continue;
      }
      if (random.chance(0.15) && sent.length > 0) {
        // A call that comes again, as after the relay changed.
        const call = random.pick(sent) as BridgeCall;
        const before = JSON.stringify(store.getState().timelines.main?.clips ?? {});
        await executor.run(call);
        expect(JSON.stringify(store.getState().timelines.main?.clips ?? {})).toBe(before);
        counted.again += 1;
        continue;
      }
      if (random.chance(0.3)) {
        const read = callOf(who, "aq_timeline_read", { timeline: "main" });
        await executor.run(read);
        continue;
      }
      const id = `clip_${who}${round}`;
      const call = callOf(who, "aq_edit", addClip(id, 300 + round));
      sent.push(call);
      const result = await executor.run(call);
      if (result.isError) {
        // Refused for a reason it says, such as what it did not read: never failed in the editor.
        expect(result.text, result.text).toMatch(
          /^error (not-read|conflict|stale|invalid|blocked|[a-z-]+):/m,
        );
        expect(result.text).not.toMatch(/the editor could not run the call/);
        counted.refused += 1;
      } else {
        made[who].add(id);
        counted.ok += 1;
      }
    }
    expect(counted.ok).toBeGreaterThan(20);
    expect(counted.again).toBeGreaterThan(5);
    expect(counted.people).toBeGreaterThan(5);
    // What one AI tool did goes back, and what the other one and people have stays.
    const there = (ids: Set<string>) => {
      const clips = store.getState().timelines.main?.clips ?? {};
      return [...ids].filter((id) => clips[id] !== undefined);
    };
    const others = [...there(made.b), ...there(made.you)];
    const own = there(made.a);
    expect(own.length).toBeGreaterThan(0);
    const origin = executor.originOf("a");
    expect(origin).toBe(aiTask("mcp-a-1"));
    const undone = store.undoOrigin(origin as string);
    expect(undone.ok).toBe(true);
    expect([...there(made.b), ...there(made.you)]).toEqual(others);
    // What people changed since stays theirs; the rest goes.
    expect(there(made.a).length).toBeLessThan(own.length);
    store.destroy();
  });
});
