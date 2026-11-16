import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { lateOf, watch, writeBatch } from "./late-writes.ts";
import type { FileChange } from "./merge-files.ts";
import { ProjectStore, repoBatch } from "./store.ts";

const MAIN = "timelines/main/timeline.json";

/** About the largest project people have: 40 tracks of 500 clips each, 20 000 clips. */
function bigStore(): ProjectStore {
  const project = createProject({ name: "大项目" });
  const main = project.timelines.get("main")?.document;
  if (!main) throw new Error("no timeline");
  const tracks = Array.from({ length: 40 }, (_, track) => ({
    id: `t${track}`,
    kind: "video",
    clips: Array.from({ length: 500 }, (_clip, index) => ({
      id: `c${track}_${index}`,
      name: `片段 ${track} ${index}`,
      start: String(index * 2),
      duration: "1",
      source: { kind: "color", color: "#000000" },
      properties: { "transform.x": index },
    })),
  }));
  return ProjectStore.create({
    ...project,
    timelines: new Map([
      ["main", { document: { ...main, tracks } as never, overrides: new Map() }],
    ]),
  });
}

describe("what the platform keeps of a merge into a big project, and what it looks at later", () => {
  it("costs little more than the merge, and a late change of the editor costs little", () => {
    const store = bigStore();
    const editor = new ProjectStore(new Y.Doc());
    Y.applyUpdate(editor.doc, store.encodeState());
    const here = { repo: "1" };
    const repository = store.exportFiles({ here }).files;
    const text = repository.get(MAIN) as string;
    const document = JSON.parse(text);
    // Names of 200 clips all over, one clip moved, and 100 clips taken away.
    for (let index = 0; index < 200; index++) {
      document.tracks[index % 40].clips[(index * 7) % 500].name = `GitHub 上改的 ${index}`;
    }
    document.tracks[5].clips[3].start = "999";
    document.tracks[6].clips.splice(0, 100);
    const batch: FileChange[] = [{ path: MAIN, base: text, text: JSON.stringify(document) }];

    let started = performance.now();
    const { result, batch: written } = writeBatch(store, "perf", () =>
      store.mergeFiles(batch, { origin: repoBatch("perf"), baseOf: undefined, here }),
    );
    const merged = performance.now() - started;
    expect(result.ok).toBe(true);
    const kept = JSON.stringify(written).length;

    // The editor changed 50 clips offline, some of them taken away on GitHub.
    const updates: Uint8Array[] = [];
    editor.onLocalUpdate((update) => updates.push(update));
    for (let index = 0; index < 50; index++) {
      editor.execute({
        type: "clip.update",
        params: { timeline: "main", clip: `c6_${index * 3}`, changes: { name: `离线 ${index}` } },
      });
    }
    const update = Y.mergeUpdates(updates);
    started = performance.now();
    const watched = watch(store, () => store.applyChecked(update, "platform"));
    const late = lateOf(store, [{ ...written, seq: 2 }], { update, watched }, () => true);
    const looked = performance.now() - started;
    expect(late.conflicts.length).toBeGreaterThan(0);
    console.log(
      `merge with what the platform keeps: ${Math.round(merged)} ms, ${Math.round(kept / 1024)} KiB kept; a late change of 50 clips: ${Math.round(looked)} ms`,
    );
    expect(merged).toBeLessThan(15_000);
    expect(looked).toBeLessThan(2_000);
  }, 120_000);
});
