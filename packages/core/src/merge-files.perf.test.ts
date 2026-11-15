import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import type { FileChange } from "./merge-files.ts";
import { mergeText } from "./merge-text.ts";
import { ProjectStore, folderBatch, repoBatch } from "./store.ts";

const MAIN = "timelines/main/timeline.json";

/**
 * A big project: 10 tracks of 500 clips each, with keys on them, and a join every fifth clip. Or
 * with `count` tracks of them.
 */
function bigStore(count = 10): ProjectStore {
  const project = createProject({ name: "大项目" });
  const main = project.timelines.get("main")?.document;
  if (!main) throw new Error("no timeline");
  const tracks = Array.from({ length: count }, (_, track) => ({
    id: `t${track}`,
    kind: "video",
    clips: Array.from({ length: 500 }, (_clip, index) => ({
      id: `c${track}_${index}`,
      name: `片段 ${track} ${index}`,
      start: String(index * 2),
      duration: "1",
      source: { kind: "color", color: "#000000" },
      properties: {
        opacity: {
          keys: [
            { time: "0", value: 0 },
            { time: "1", value: 1 },
          ],
        },
        "transform.x": index,
      },
    })),
    joins: Array.from({ length: 100 }, (_join, join) => ({
      id: `j${track}_${join}`,
      from: `c${track}_${join * 5}`,
      to: `c${track}_${join * 5 + 1}`,
      type: "fade",
      duration: "0.5",
    })),
  }));
  return ProjectStore.create({
    ...project,
    timelines: new Map([
      ["main", { document: { ...main, tracks } as never, overrides: new Map() }],
    ]),
  });
}

/** The quickest of a few runs: one slow run on a busy machine says little. */
function quickest(runs: number, run: (round: number) => () => void): number {
  let best = Infinity;
  for (let round = 0; round < runs; round++) {
    // Only what the run is about counts, not what it takes to set it up.
    const measured = run(round);
    const started = performance.now();
    measured();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("merging files of a big project", () => {
  it("takes in one change to a timeline of 5000 clips and 1000 joins quickly", () => {
    const store = bigStore();
    // The editor wrote the files, and then something changed one name in the folder.
    const took = quickest(4, (round) => {
      const folder = store.exportFiles().files;
      const text = folder.get(MAIN) as string;
      const document = JSON.parse(text);
      document.tracks[3].clips[7].name = `外面改的 ${round}`;
      const batch: FileChange[] = [
        { path: MAIN, base: text, text: JSON.stringify(document, null, 2) },
      ];
      return () => {
        const result = store.mergeFiles(batch, {
          origin: folderBatch(`${round}`),
          baseOf: (path) => folder.get(path),
        });
        expect(result.ok).toBe(true);
      };
    });
    expect(took).toBeLessThan(400);
  });

  it("takes in a commit of GitHub into a timeline of 20 000 clips as the platform, in seconds", () => {
    // About the largest project people have: 2026-11-12, a timeline of more than 20 000 clips.
    const store = bigStore(40);
    const here = { repo: "1" };
    const repository = store.exportFiles({ here }).files;
    const text = repository.get(MAIN) as string;
    const document = JSON.parse(text);
    // Names of 200 clips all over, and one clip moved.
    for (let index = 0; index < 200; index++) {
      document.tracks[index % 40].clips[(index * 7) % 500].name = `GitHub 上改的 ${index}`;
    }
    document.tracks[5].clips[3].start = "999";
    const batch: FileChange[] = [{ path: MAIN, base: text, text: JSON.stringify(document) }];
    // What the merge left on the heap, garbage included: it runs all at once, so nothing can look
    // in between. Only to know how large it is.
    const atStart = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = store.writeAsPlatform(() =>
      store.mergeFiles(batch, { origin: repoBatch("perf"), baseOf: undefined, here }),
    );
    const took = performance.now() - started;
    const grew = process.memoryUsage().heapUsed - atStart;
    expect(result.ok).toBe(true);
    expect(Object.keys(store.getState().timelines["main"]?.clips ?? {})).toHaveLength(20_000);
    console.log(
      `merge of a commit into 20 000 clips: ${Math.round(took)} ms, heap +${Math.round(grew / 1024 ** 2)} MiB`,
    );
    expect(took).toBeLessThan(10_000);
  }, 60_000);

  it("merges code a formatter changed all over with one line of the editor quickly", () => {
    const base = Array.from({ length: 20_000 }, (_, index) => `const a${index} = ${index};\n`);
    const theirs = base.map((line, index) => (index % 5 === 0 ? line.replace(" = ", "=") : line));
    const ours = [...base];
    ours[10_002] = "// 编辑器\n";
    let conflicts = -1;
    const [was, mine, other] = [base.join(""), ours.join(""), theirs.join("")];
    const took = quickest(3, () => () => {
      conflicts = mergeText(was, mine, other).conflicts.length;
    });
    expect(conflicts).toBe(0);
    expect(took).toBeLessThan(1500);
  });
});
