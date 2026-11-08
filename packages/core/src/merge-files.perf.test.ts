import { createProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import type { FileChange } from "./merge-files.ts";
import { mergeText } from "./merge-text.ts";
import { ProjectStore, folderBatch } from "./store.ts";

const MAIN = "timelines/main/timeline.json";

/** A big project: 10 tracks of 500 clips each, with keys on them, and a join every fifth clip. */
function bigStore(): ProjectStore {
  const project = createProject({ name: "大项目" });
  const main = project.timelines.get("main")?.document;
  if (!main) throw new Error("no timeline");
  const tracks = Array.from({ length: 10 }, (_, track) => ({
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
