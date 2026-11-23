import { afterEach, describe, expect, test } from "vitest";
import { Editor, projectMap, write, type Level } from "../test/archive-support.ts";
import { ExportFailed, ProjectExporter, type ExportSession } from "./exporter.ts";
import { blobShaOf, bytesOf } from "./repo-host.ts";

/** Making a project into files in a thread of its own, as an archive does. */

const sessions: ExportSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});
const open = (heapMb = 256) => {
  const session = new ProjectExporter({ heapMb }).open();
  sessions.push(session);
  return session;
};

describe("the export of a project for an archive", () => {
  test("has the files of the format as the editor writes them, each with the SHA-1 Git names it by", async () => {
    const editor = new Editor();
    const first = editor.store.encodeWhole();
    const second = editor.change(write("code/a.js", "export const 中 = 1;\n"));
    const result = await open().export([first, second]);
    const expected = editor.store.exportFiles().files;
    expect([...result.files.keys()].toSorted()).toEqual([...expected.keys()].toSorted());
    for (const [path, text] of expected) {
      expect(result.files.get(path)).toEqual({ text, sha: blobShaOf(bytesOf(text)) });
    }
    expect(result.invalid.size).toBe(0);
    expect(result.projectId).toBe(editor.projectId);
    expect(result.peakHeap).toBeGreaterThan(0);
  });

  test("names the documents it cannot write, and what is wrong with them", async () => {
    const editor = new Editor();
    const first = editor.store.encodeWhole();
    const broken = editor.raw((doc) =>
      ((projectMap(doc).get("timelines") as Level).get("main") as Level).set("name", 123),
    );
    const result = await open().export([first, broken]);
    expect([...result.invalid]).toEqual(["timelines/main/timeline.json"]);
    expect(result.files.has("timelines/main/timeline.json")).toBe(false);
    expect(result.problems[0]).toMatch(/^timelines\/main\/timeline\.json name: /);
  });

  test("makes nothing of updates that miss one before them", async () => {
    const editor = new Editor();
    editor.store.encodeWhole();
    const skipped = editor.change(write("code/a.js", "a"));
    const after = editor.change(write("code/a.js", "ab"));
    void skipped;
    await expect(open().export([after])).rejects.toBeInstanceOf(ExportFailed);
  });

  test("reads what a repository would have, as a project", async () => {
    const editor = new Editor();
    const files = editor.store.exportFiles().files;
    const session = open();
    expect(await session.check(files)).toEqual([]);
    const without = new Map(files);
    without.delete("timelines/main/timeline.json");
    expect((await session.check(without))[0]).toMatch(/^animaquill\.json: /);
  });

  test("a project larger than its heap ends the thread, not the process", async () => {
    const editor = new Editor();
    const first = editor.store.encodeWhole();
    // Many small pieces: what takes a heap, more than a long string does.
    const seed = editor.change(write("code/seed.js", "s"));
    const files = projectMap(editor.store.doc).get("files") as Level;
    const Text = (
      files.get("code/seed.js") as {
        constructor: new () => { insert(at: number, text: string): void };
      }
    ).constructor;
    const many = editor.raw(() => {
      for (let index = 0; index < 60_000; index++) {
        const text = new Text();
        files.set(`code/many/f${index}.js`, text);
        text.insert(0, `export const n${index} = ${index};`);
      }
    });
    const session = open(16);
    const failed = await session.export([first, seed, many]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(ExportFailed);
    // The next archive gets a thread of its own.
    expect((await open().export([first])).files.size).toBeGreaterThan(0);
  }, 30_000);
});
