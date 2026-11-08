/**
 * Random tests of the folder session, see fuzz-*.test.ts: the editor, another program and the
 * browser do things in any order, with crashes, missed changes, two windows, sleeping windows and a
 * folder that goes away. They are in several files so that they run at the same time.
 *
 * What each side changes is kept apart, so that what has to come of it is known exactly: the editor
 * names clips and writes code/editor.js, the other program changes notes, markers, strings and the
 * lines of code/animate.js, and breaks and fixes files. Nothing of either may get lost, nothing may
 * come in twice, and in the end the folder holds what the project holds.
 */
import { ProjectStore, readFolder } from "@animaquill/core";
import { MANIFEST_FILE } from "@animaquill/schema";
import { expect } from "vitest";
import { randomFrom, type Random } from "../../../core/src/fuzz-support.ts";
import {
  CODE,
  MAIN,
  NOTES,
  PROJECT,
  TestBrowser,
  clipName,
  filesOf,
  fixture,
  renameClip,
  run,
  type TestWindow,
} from "./folder-support.ts";

const LOCALE = "locales/en.json";
const EDITOR_CODE = "code/editor.js";
const AWAY = `${PROJECT}-搬走`;
/** Files the other program breaks now and then. */
const BREAKABLE = [NOTES, MAIN, LOCALE];
/** What is not the project's, and has to stay as it is. */
const OTHERS: Readonly<Record<string, string>> = {
  "README.md": "# 原子\n",
  ".git/config": "[core]\n",
  "制作笔记/新的.md": "笔记\n",
};

/** What the other program does: always on what the folder has, as a program that reads first. */
class Outside {
  readonly #browser: TestBrowser;
  readonly #random: Random;
  #count = 0;
  /** Where the folder is now. */
  root = PROJECT;
  /** What it last read or wrote of a file that it can read, to fix it with after breaking it. */
  readonly lastGood = new Map<string, string>();
  readonly broken = new Set<string>();
  manifestGone = false;
  /** What has to be in the project in the end, as far as it goes. */
  note: string | undefined;
  readonly markers = new Map<string, string>();
  readonly strings = new Map<string, string>();
  readonly lines: string[] = [];

  constructor(browser: TestBrowser, random: Random) {
    this.#browser = browser;
    this.#random = random;
  }

  get #disk() {
    return this.#browser.disk;
  }

  #fresh(): string {
    this.#count += 1;
    return `X${this.#count}`;
  }

  #path(path: string): string {
    return `${this.root}/${path}`;
  }

  /** How programs write: now and then without the browser hearing of it, as on Linux. */
  #write(path: string, text: string): void {
    const quietly = this.#random.chance(0.15);
    this.#disk.write(this.#path(path), text, { quietly });
  }

  #read(path: string): any {
    if (this.broken.has(path) || !this.#disk.has(this.#path(path))) return undefined;
    const text = this.#disk.text(this.#path(path));
    try {
      const document = JSON.parse(text);
      this.lastGood.set(path, text);
      return document;
    } catch {
      return undefined;
    }
  }

  #json(document: unknown): string {
    return this.#random.chance(0.5)
      ? JSON.stringify(document)
      : `${JSON.stringify(document, null, this.#random.pick([1, 2, 4]))}\n`;
  }

  #change(path: string, document: any): void {
    if (path === NOTES) {
      this.note = this.#fresh();
      document.notes[0].text = this.note;
    } else if (path === MAIN) {
      const marker = document.markers[this.#random.int(document.markers.length)];
      marker.name = this.#fresh();
      this.markers.set(marker.id, marker.name);
    } else if (path === LOCALE) {
      const key = this.#random.pick(Object.keys(document.strings)) as string;
      document.strings[key].text = this.#fresh();
      this.strings.set(key, document.strings[key].text);
    }
  }

  /** Changes a document, or fixes it if it broke it before. */
  edit(): string {
    const path = this.#random.pick([NOTES, MAIN, LOCALE]) as string;
    if (this.broken.has(path)) return this.fix(path);
    const document = this.#read(path);
    if (!document) return "skip";
    this.#change(path, document);
    this.#write(path, this.#json(document));
    this.lastGood.set(path, this.#disk.text(this.#path(path)));
    return `edit ${path}`;
  }

  act(): string {
    if (this.manifestGone) {
      if (this.#random.chance(0.4)) return this.restoreManifest();
    }
    const roll = this.#random.int(100);
    if (roll < 45) return this.edit();
    if (roll < 65) {
      if (!this.#disk.has(this.#path(CODE))) return "skip";
      const lines = this.#disk.text(this.#path(CODE)).split(/(?<=\n)/);
      const line = `// ${this.#fresh()}\n`;
      lines.splice(this.#random.int(lines.length + 1), 0, line);
      this.lines.push(line);
      this.#write(CODE, lines.join(""));
      return "line";
    }
    if (roll < 73) {
      const path = this.#random.pick(BREAKABLE) as string;
      if (this.broken.has(path) || !this.#read(path)) return "skip";
      this.broken.add(path);
      this.#write(path, `{坏了 ${this.#fresh()}`);
      return `break ${path}`;
    }
    if (roll < 83) {
      const path = this.#random.pick([...this.broken]);
      return path === undefined ? "skip" : this.fix(path);
    }
    if (roll < 90) {
      const path = this.#random.pick([NOTES, MAIN, LOCALE, CODE]) as string;
      if (this.broken.has(path) || !this.#disk.has(this.#path(path))) return "skip";
      // The same content again, with a new time: nothing changed.
      if (this.#random.chance(0.5)) this.#disk.touch(this.#path(path));
      else this.#write(path, this.#disk.text(this.#path(path)));
      return `same ${path}`;
    }
    if (roll < 94 && !this.manifestGone) {
      const text = this.#disk.text(this.#path(MANIFEST_FILE));
      this.lastGood.set(MANIFEST_FILE, text);
      this.#disk.remove(this.#path(MANIFEST_FILE), { quietly: this.#random.chance(0.15) });
      this.manifestGone = true;
      return "remove manifest";
    }
    return "skip";
  }

  fix(path: string): string {
    const document = JSON.parse(this.lastGood.get(path) as string);
    this.#change(path, document);
    this.broken.delete(path);
    this.#write(path, this.#json(document));
    this.lastGood.set(path, this.#disk.text(this.#path(path)));
    return `fix ${path}`;
  }

  restoreManifest(): string {
    this.#write(MANIFEST_FILE, this.lastGood.get(MANIFEST_FILE) as string);
    this.manifestGone = false;
    return "restore manifest";
  }

  /** Puts right what it broke, as people would before they stop. */
  tidy(): void {
    for (const path of this.broken) this.fix(path);
    if (this.manifestGone) this.restoreManifest();
  }
}

/** What the editor did, which has to be in the project in the end. */
class Editor {
  readonly #random: Random;
  #count = 0;
  readonly names = new Map<string, string>();
  code = "";
  readonly #clips: readonly string[];

  constructor(random: Random, clips: readonly string[]) {
    this.#random = random;
    this.#clips = clips;
  }

  async act(window: TestWindow): Promise<string> {
    this.#count += 1;
    if (this.#random.chance(0.75)) {
      const clip = this.#random.pick(this.#clips) as string;
      const name = `E${this.#count}`;
      renameClip(window.store, clip, name);
      this.names.set(clip, name);
    } else {
      this.code = `${this.code}// E${this.#count}\n`;
      run(window.store, "file.write", { path: EDITOR_CODE, text: this.code });
    }
    // As people work: every change is in the log at once, see ProjectSession.
    expect(await window.project.trySave()).toBe(true);
    return "editor";
  }
}

const isAlive = (window: TestWindow) => !window.dead;

/** One random run: what happens, and what has to be true in the end. */
export async function fuzzFolder(seed: number, steps = 40): Promise<void> {
  const random = randomFrom(seed);
  const system = random.chance(0.5) ? "windows" : "linux";
  const files = fixture();
  for (const [path, text] of Object.entries(OTHERS)) files.set(path, text);
  const browser = new TestBrowser({ system }, files);
  const outside = new Outside(browser, random);
  const first = await browser.open();
  const main = first.store.getState().timelines["main"];
  // A locked track keeps its clips from the editor too.
  const clips = Object.values(main?.clips ?? {})
    .filter(({ track }) => main?.tracks[track]?.locked !== true)
    .map(({ id }) => id);
  const editor = new Editor(random, clips);
  if (random.chance(0.5)) await browser.open();
  const said: string[] = [];
  const live = () => browser.windows.filter(isAlive);
  /** Crashes at a write wait for that write: in the end there is none any more. */
  let canCrash = true;
  const crash = () => {
    if (canCrash) browser.crash();
  };

  for (let step = 0; step < steps; step++) {
    const roll = random.int(100);
    const windows = live();
    if (roll < 35) {
      const window = random.pick(windows);
      if (window) said.push(await editor.act(window));
    } else if (roll < 70) {
      said.push(outside.act());
    } else if (roll < 74) {
      // The browser crashes, or the computer goes off, maybe right at a write.
      const path = random.pick([MAIN, NOTES, CODE, EDITOR_CODE, MANIFEST_FILE]) as string;
      const at = `${outside.root}/${path}`;
      const how = random.int(3);
      if (how === 0) browser.crash();
      else if (how === 1) browser.disk.onNext("written", at, crash);
      else {
        // The power goes right after a write: the file is empty, or as long and with nothing in it.
        const empty = random.chance(0.3);
        browser.disk.onNext("written", at, () => {
          if (!canCrash) return;
          const left = empty ? new Uint8Array() : new Uint8Array(browser.disk.bytes(at).length);
          browser.disk.write(at, left, { quietly: true });
          crash();
        });
      }
      said.push(`crash ${how}`);
    } else if (roll < 78) {
      if (windows.length < 2) {
        await browser.open();
        said.push("open");
      } else {
        const window = random.pick(windows) as TestWindow;
        await window.session.close();
        await window.project.close();
        window.dead = true;
        said.push("close");
      }
    } else if (roll < 82) {
      const writer = windows.find(({ session }) => session.getSnapshot().role === "writing");
      if (writer) {
        const asleep = random.chance(0.6);
        browser.disk.sleep(writer.folders, asleep);
        said.push(asleep ? "sleep" : "wake");
      }
    } else if (roll < 86) {
      browser.disk.missesChanges = !browser.disk.missesChanges;
      said.push(`misses ${browser.disk.missesChanges}`);
    } else if (roll < 89) {
      browser.disk.front();
      said.push("front");
    } else if (roll < 92 && outside.root === PROJECT && !outside.manifestGone) {
      // The folder goes somewhere else for a moment, and comes back.
      browser.disk.move(PROJECT, AWAY);
      outside.root = AWAY;
      await browser.settle(random.int(3000));
      if (random.chance(0.5)) said.push(outside.edit());
      browser.disk.move(AWAY, PROJECT);
      outside.root = PROJECT;
      for (const window of live()) await window.session.reconnect();
      said.push("away and back");
    } else {
      said.push("wait");
    }
    if (live().length === 0) {
      // After a crash, people open it again.
      for (const window of browser.windows) {
        window.dead = true;
      }
      await browser.open();
      if (random.chance(0.3)) await browser.open();
    }
    await browser.settle(random.pick([0, 200, 700, 1200, 3000, 6000]) as number);
  }

  // People stop, and everything gets the time it needs.
  canCrash = false;
  outside.tidy();
  browser.disk.missesChanges = false;
  for (const window of live()) browser.disk.sleep(window.folders, false);
  if (live().length === 0) await browser.open();
  for (const window of live()) await window.session.reconnect();
  browser.disk.front();
  await browser.settle(40_000);
  const windows = live();
  for (const window of windows) await window.session.flush();
  await browser.settle(12_000);

  const context = `seed ${seed}: ${said.join(", ")}`;
  const writer = windows.find(({ session }) => session.getSnapshot().role === "writing");
  expect(writer, context).toBeDefined();
  const { store, session } = writer as TestWindow;
  expect(session.getSnapshot(), context).toMatchObject({
    status: "saved",
    trouble: undefined,
    blocked: [],
  });
  // What the editor did is all there.
  for (const [clip, name] of editor.names) expect(clipName(store, clip), context).toBe(name);
  if (editor.code !== "") expect(store.getState().files[EDITOR_CODE], context).toBe(editor.code);
  // What the other program did is all there, and only once.
  const state = store.getState();
  if (outside.note !== undefined) expect(state.notes?.["note_1"]?.text, context).toBe(outside.note);
  for (const [id, name] of outside.markers) {
    expect(state.timelines["main"]?.markers[id]?.name, context).toBe(name);
  }
  for (const [key, text] of outside.strings) {
    expect(state.locales["en"]?.[key]?.text, context).toBe(text);
  }
  const code = state.files[CODE] ?? "";
  for (const line of outside.lines) {
    expect(code.split(line).length - 1, `${context}: ${line}`).toBe(1);
  }
  // Every window has the same project.
  for (const other of windows) {
    expect(other.store.exportFiles().files, context).toEqual(store.exportFiles().files);
  }
  // The folder holds what the project holds.
  const disk = filesOf(browser.disk);
  const reading = await readFolder({
    list: async function* () {
      for (const path of disk.keys()) yield path;
    },
    file: async (path) => new Blob([disk.get(path) as string]),
  });
  const opened = ProjectStore.create(reading.project, reading.sources);
  expect(opened.exportFiles().files, context).toEqual(store.exportFiles().files);
  // And what is not the project's is as it was.
  for (const [path, text] of Object.entries(OTHERS)) expect(disk.get(path), context).toBe(text);
  expect(disk.get("AGENTS.md"), context).toBe(fixture().get("AGENTS.md"));
}
