import { isFolderProblem, readFolder, type FolderReading } from "@animaquill/core";
import { diskFolder } from "@animaquill/core/disk-folder";
import { documentSchema, type Problem } from "@animaquill/schema";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sourceFromFiles } from "../../../host/src/folders.ts";
import { loadFixture } from "../../../schema/scripts/fixture.ts";
import { createI18n } from "../i18n/i18n.ts";
import { ImportRefused, readProjectFolder, type ProjectFolder } from "./import.ts";
import { memorySource } from "./memory-folder.ts";

const { t } = await createI18n();

const SAMPLE = fileURLToPath(new URL("../../../schema/fixtures/v1", import.meta.url));

const made: string[] = [];

afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/**
 * What a browser hands over for a folder people chose: every file below it as a `File`, with its
 * path from the folder itself, and no links, which a browser does not show. In an order of its own.
 */
function filesOf(folder: string): File[] {
  const files: File[] = [];
  const walk = (place: string, prefix: string) => {
    for (const entry of readdirSync(place, { withFileTypes: true })) {
      const path = join(place, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else if (entry.isFile()) {
        const file = new File([new Uint8Array(readFileSync(path))], entry.name);
        const relative = `${basename(folder)}/${prefix}${entry.name}`;
        Object.defineProperty(file, "webkitRelativePath", { value: relative });
        files.push(file);
      }
    }
  };
  walk(folder, "");
  return files.toReversed();
}

/** What the format says has its own words. What reading a folder says, the editor puts in words. */
const withoutWords = (problem: Problem): Problem =>
  isFolderProblem(problem) ? { ...problem, message: "" } : problem;

/** The same project, the same files and the same problems. */
function expectSame(folder: ProjectFolder, reading: FolderReading) {
  expect(folder.project).toEqual(reading.project);
  expect(folder.sources).toEqual(reading.sources);
  expect(folder.skipped).toEqual(reading.skipped);
  expect([...folder.files.keys()].toSorted()).toEqual(reading.files.toSorted());
  const lostOf = (lost: readonly { file: string; problems: readonly Problem[] }[]) =>
    lost.map(({ file, problems }) => ({ file, problems: problems.map(withoutWords) }));
  expect(lostOf(folder.lost)).toEqual(lostOf(reading.lost));
  expect(folder.warnings.map(withoutWords)).toEqual(reading.warnings.map(withoutWords));
}

describe("a folder on a disk", () => {
  it("is the same project in Node as in a browser", async () => {
    const reading = await readFolder(await diskFolder(SAMPLE));
    const folder = await readProjectFolder(sourceFromFiles(filesOf(SAMPLE)), t);
    expectSame(folder, reading);
    expect(reading.project.manifest.name).toBe("原子是什么");
    expect(reading.lost).toEqual([]);
    expect(reading.skipped).toEqual(["AGENTS.md", "制作笔记/分镜.md"]);
    expect(Object.keys(reading.sources).toSorted()).toEqual([
      "code/animate.js",
      "scenes/title/index.html",
      "sounds/impacts/main.js",
    ]);
  });

  it("is the same in Node as in a browser with everything that can be wrong with it", async () => {
    const chosen = join(mkdtempSync(join(tmpdir(), "animaquill-")), "备份");
    made.push(dirname(chosen));
    const project = join(chosen, "原子是什么");
    cpSync(SAMPLE, project, { recursive: true });
    const write = (path: string, content: string | Uint8Array) => {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), content);
    };
    const NO_TEXT = new Uint8Array([0xff, 0xfe, 0x00, 0xc3]);
    write("../说明.txt", "这个文件夹里是备份");
    write("assets.json", `\uFEFF${readFileSync(join(SAMPLE, "assets.json"), "utf8")}`);
    write(
      "scenes/title/index.html",
      `\uFEFF${readFileSync(join(SAMPLE, "scenes/title/index.html"), "utf8")}`,
    );
    write("notes.json", "{ 坏了");
    write("locales/en.json", NO_TEXT);
    write("timelines/extra/timeline.json", "{ 坏了");
    write("code/bad.js", NO_TEXT);
    write(".git/HEAD", "ref: refs/heads/main");
    write("node_modules/x/index.js", "");
    write("scenes/title/node_modules/y.js", "");
    write(".DS_Store", "");
    write("assets/Thumbs.db", "");
    write("README.md", "说明");
    rmSync(join(project, "sounds/impacts/main.js"));
    // What a link points at can be anywhere, and none of it is read.
    writeFileSync(join(dirname(chosen), "外面.js"), "export const secret = 1;");
    symlinkSync(join(dirname(chosen), "外面.js"), join(project, "code/link.js"));

    const reading = await readFolder(await diskFolder(chosen));
    const folder = await readProjectFolder(sourceFromFiles(filesOf(chosen)), t);
    expectSame(folder, reading);

    expect(reading.root).toBe("原子是什么/");
    expect(reading.skipped).toEqual(["AGENTS.md", "README.md", "code/bad.js", "制作笔记/分镜.md"]);
    expect(reading.sources["scenes/title/index.html"]?.startsWith("\uFEFF")).toBe(true);
    expect(reading.sources["code/link.js"]).toBeUndefined();
    expect(reading.project.assets).toBeDefined();
    expect(reading.lost.map(({ file, part }) => [file, part])).toEqual([
      ["locales/en.json", { kind: "locale", id: "en" }],
      ["timelines/extra/timeline.json", { kind: "timeline", id: "extra", listed: false }],
      ["notes.json", { kind: "notes" }],
    ]);
    expect(folder.lost.map(({ consequence }) => consequence)).toEqual([
      "语言 en 的文字：全部不会带入，用到这些文字的地方会空着。",
      "时间轴 extra：不在项目的时间轴列表里，整条不会带入。",
      "批注：全部不会带入。",
    ]);
    expect(folder.lost[0]?.problems).toEqual([
      { severity: "error", code: "not-text", file: "locales/en.json", message: "不是 UTF-8 文本" },
    ]);
    expect(folder.warnings.filter(isFolderProblem)).toEqual([
      {
        severity: "warning",
        code: "entry-missing",
        file: "sounds/impacts/main.js",
        message: "这个入口文件不在文件夹里。如果它是一个符号链接，浏览器看不到它",
      },
    ]);
  });
});

describe("what people get to read", () => {
  const fixture = loadFixture("v1");
  const BROKEN = "{ oops";
  const read = (files: Iterable<readonly [string, string | Uint8Array<ArrayBuffer>]>) =>
    readProjectFolder(memorySource("示例", files), t);

  it("says what each document costs", async () => {
    const documents = [...fixture.keys()].filter(
      (path) => path !== "animaquill.json" && documentSchema(path) !== undefined,
    );
    const said = new Map<string, string | undefined>();
    for (const path of documents) {
      const { lost } = await read(new Map(fixture).set(path, BROKEN));
      said.set(path, lost[0]?.consequence);
    }
    const manifest = JSON.parse(fixture.get("animaquill.json") as string);
    const unlisted = await read(
      new Map(fixture)
        .set("animaquill.json", JSON.stringify({ ...manifest, timelines: ["main"] }))
        .set("timelines/highlight/timeline.json", BROKEN),
    );
    said.set("unlisted", unlisted.lost[0]?.consequence);
    expect(Object.fromEntries(said)).toEqual({
      "assets.json": "素材清单：所有素材都不会带入，用到素材的片段没有画面和声音，素材要重新导入。",
      "libraries.json": "库的关联：全部不会带入，用到库的片段没有内容。",
      "libraries.lock.json": "库的版本记录：不会带入，库可能换成别的版本。",
      "notes.json": "批注：全部不会带入。",
      "locales/en.json": "语言 en 的文字：全部不会带入，用到这些文字的地方会空着。",
      "locales/zh-CN.json": "语言 zh-CN 的文字：全部不会带入，用到这些文字的地方会空着。",
      "scenes/title/scene.json":
        "场景 title：不会带入，用到它的片段没有内容。它的代码文件还在项目里。",
      "sounds/impacts/sound.json":
        "声音 impacts：不会带入，用到它的片段没有声音。它的代码文件还在项目里。",
      "timelines/highlight/timeline.json":
        "时间轴 highlight：里面的轨道、片段和标记都不会带入，导入后这条时间轴是空的。",
      "timelines/main/timeline.json":
        "时间轴 main：里面的轨道、片段和标记都不会带入，导入后这条时间轴是空的。",
      "timelines/main/overrides/format.vertical.json":
        "时间轴 main 的版本调整 format.vertical：这个语言或画幅的改动不会带入。",
      "timelines/main/overrides/language.en.json":
        "时间轴 main 的版本调整 language.en：这个语言或画幅的改动不会带入。",
      "timelines/main/overrides/version.en.vertical.json":
        "时间轴 main 的版本调整 version.en.vertical：这个语言或画幅的改动不会带入。",
      unlisted: "时间轴 highlight：不在项目的时间轴列表里，整条不会带入。",
    });
  });

  it("names a timeline that comes in empty, so that people see what happened to it", async () => {
    const { project, lost } = await read(
      new Map(fixture).set("timelines/main/timeline.json", BROKEN),
    );
    expect(project.timelines.get("main")?.document?.name).toBe("main（内容没有带入）");
    expect(lost[0]?.problems[0]?.code).toBe("invalid-json");
  });

  it("says what reading the folder found, in words of the editor", async () => {
    const missing = new Map(fixture);
    missing.delete("timelines/highlight/timeline.json");
    missing.delete("scenes/title/index.html");
    missing.set("notes.json", new Uint8Array([0xff, 0xfe]) as never);
    const { lost, warnings } = await read(missing);
    expect(lost.flatMap(({ problems }) => problems)).toEqual([
      { severity: "error", code: "not-text", file: "notes.json", message: "不是 UTF-8 文本" },
      {
        severity: "error",
        code: "timeline-not-in-folder",
        file: "timelines/highlight/timeline.json",
        message: "文件夹里没有这条时间轴",
      },
    ]);
    expect(warnings.filter(isFolderProblem)).toEqual([
      {
        severity: "warning",
        code: "entry-missing",
        file: "scenes/title/index.html",
        message: "这个入口文件不在文件夹里。如果它是一个符号链接，浏览器看不到它",
      },
    ]);
  });

  it("says why a folder is refused in words of the editor too", async () => {
    const error = await read(
      new Map(fixture).set("animaquill.json", new Uint8Array([0xff, 0xfe]) as never),
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ImportRefused);
    expect((error as ImportRefused).reason).toBe("invalid");
    expect((error as ImportRefused).problems[0]).toEqual({
      severity: "error",
      code: "not-text",
      file: "animaquill.json",
      message: "不是 UTF-8 文本",
    });
  });

  it("says how far it got: every file as it finds them, then each one it reads", async () => {
    const files = [...fixture].map(([path, text]) => [`备份/${path}`, text] as const);
    const steps: unknown[] = [];
    await readProjectFolder(memorySource("示例", files), t, { onStep: (step) => steps.push(step) });
    const opened = files
      .map(([path]) => path.slice("备份/".length))
      .filter((path) => documentSchema(path) !== undefined || /^(scenes|sounds|code)\//.test(path));
    expect(steps).toEqual(
      [...files.map(([path]) => path), ...opened].map((file) => ({ file, done: 0, total: 0 })),
    );
  });

  it("stops reading as soon as people cancel", async () => {
    const stop = new AbortController();
    const source = memorySource("示例", fixture);
    let reads = 0;
    const counting = {
      name: source.name,
      async *files() {
        for await (const file of source.files()) {
          yield {
            path: file.path,
            read: () => {
              reads += 1;
              stop.abort(new DOMException("cancelled", "AbortError"));
              return file.read();
            },
          };
        }
      },
    };
    const error = await readProjectFolder(counting, t, { signal: stop.signal }).catch(
      (failure: unknown) => failure,
    );
    expect((error as Error).name).toBe("AbortError");
    expect(reads).toBe(1);
  });

  it("leaves other failures as they are", async () => {
    const failing = memorySource("示例", fixture);
    const error = await readProjectFolder(
      {
        name: failing.name,
        async *files() {
          for await (const file of failing.files()) {
            yield {
              path: file.path,
              read: () => Promise.reject(new DOMException("gone", "NotFoundError")),
            };
          }
        },
      },
      t,
    ).catch((failure: unknown) => failure);
    expect(error).not.toBeInstanceOf(ImportRefused);
    expect((error as Error).name).toBe("NotFoundError");
  });
});
