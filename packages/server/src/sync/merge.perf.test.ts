import { ProjectStore, type FileChange } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { afterAll, describe, expect, test } from "vitest";
import { batchRow } from "./batches.ts";
import { WorkingCopies } from "./copies.ts";
import { SYNC_HUB_LIMITS } from "./hub.ts";

/**
 * How long a merge from GitHub holds up the thread of the working copies, which every project
 * shares, for the largest projects people have and for the most files one merge takes
 * (`mergeFiles`): what the limits in the design go by. Times are printed; the bounds are only far
 * off, for a busy machine.
 */

const MAIN = "timelines/main/timeline.json";
const quiet = { warn() {} };

/** 40 tracks of 500 clips each: a timeline of 20 000 clips, about the largest one people have. */
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

describe("a merge from GitHub in the thread of the working copies", () => {
  // As much memory as the platform gives the thread, and no less to the project: a timeline of
  // 20 000 clips is more than `projectMemory` estimates a project may take, and only its time is
  // measured here.
  const copies = new WorkingCopies({
    heapMb: SYNC_HUB_LIMITS.copiesHeapMb,
    budget: 1024 ** 3,
    perPerson: 1024 ** 3,
    perProject: 1024 ** 3,
    log: quiet,
  });
  afterAll(async () => {
    await copies.stop();
  });

  const timed = async <T>(run: () => Promise<T>): Promise<[T, number]> => {
    const started = performance.now();
    const result = await run();
    return [result, Math.round(performance.now() - started)];
  };

  test("of a commit into a timeline of 20 000 clips takes seconds at most", async () => {
    const store = bigStore();
    const here = { repo: "1" };
    const state = store.encodeState();
    const repository = store.exportFiles({ here }).files;
    const text = repository.get(MAIN) as string;
    const document = JSON.parse(text);
    for (let index = 0; index < 200; index++) {
      document.tracks[index % 40].clips[(index * 7) % 500].name = `GitHub 上改的 ${index}`;
    }
    document.tracks[6].clips.splice(0, 100);
    const changes: FileChange[] = [{ path: MAIN, base: text, text: JSON.stringify(document) }];
    await copies.open(
      "big",
      [state],
      store.getState().manifest.id,
      state.length,
      "ada",
      new Set(["big"]),
    );
    // What the hub does: the project as it was, then the merge.
    const [before, encoded] = await timed(() => copies.encode("big"));
    const [merged, took] = await timed(() =>
      copies.merge("big", { changes, batch: "perf", here, prefer: "editor", seq: 2, watched: 50 }),
    );
    expect(merged.kind).toBe("merged");
    if (merged.kind !== "merged") return;
    const kept = batchRow(merged.batch).length;
    console.log(
      `20 000 clips: snapshot ${encoded} ms (${Math.round(before.length / 1024)} KiB), merge ${took} ms in all (${merged.ms} ms in the thread), batch ${Math.round(kept / 1024)} KiB`,
    );
    expect(took).toBeLessThan(20_000);
  }, 120_000);

  test(`of the most files one merge takes, ${SYNC_HUB_LIMITS.mergeFiles}, takes seconds at most`, async () => {
    const store = ProjectStore.create(createProject({ name: "很多文件" }));
    const here = { repo: "2" };
    const state = store.encodeState();
    const line = "export const value = 1; // 一行代码\n";
    const changes: FileChange[] = Array.from(
      { length: SYNC_HUB_LIMITS.mergeFiles },
      (_, index) => ({
        path: `code/f${index}.js`,
        base: undefined,
        text: line.repeat(100),
      }),
    );
    await copies.open(
      "many",
      [state],
      store.getState().manifest.id,
      state.length,
      "bob",
      new Set(["many"]),
    );
    const [merged, took] = await timed(() =>
      copies.merge("many", {
        changes,
        batch: "files",
        here,
        prefer: "editor",
        seq: 2,
        watched: 50,
      }),
    );
    expect(merged.kind).toBe("merged");
    if (merged.kind !== "merged") return;
    const bytes = changes.reduce((sum, change) => sum + (change.text?.length ?? 0), 0);
    console.log(
      `${changes.length} files of ${Math.round(bytes / 1024 ** 2)} MiB: merge ${took} ms in all (${merged.ms} ms in the thread), delta ${Math.round((merged.delta?.length ?? 0) / 1024)} KiB`,
    );
    expect(took).toBeLessThan(20_000);
  }, 120_000);
});
