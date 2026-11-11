/**
 * Random tests of the folder session, see fuzz-*.test.ts: the editor, another program and the
 * browser do things in any order, with crashes, missed changes, two windows, sleeping windows and a
 * folder that goes away. They are in several files so that they run at the same time.
 *
 * What each side changes is kept apart, so that what has to come of it is known exactly: the editor
 * names clips and writes code/editor.js, the other program changes notes, markers, strings and the
 * lines of code/animate.js, and breaks and fixes files. One clip both name: where they do at once,
 * the editor's name stays, and what the folder had is kept in recovered. Nothing of either may get
 * lost, nothing may come in twice, and in the end the folder holds what the project holds. Around
 * them the browser's database fails now and then, files cannot be read for a while, the power takes
 * back a write, and the browser tells late that a window waits or lost its turn.
 */
import { ProjectStore, readFolder } from "@animaquill/core";
import { MANIFEST_FILE } from "@animaquill/schema";
import { expect } from "vitest";
import { randomFrom, seedIds, type Random } from "../../../core/src/fuzz-support.ts";
import {
  CODE,
  MAIN,
  NOTES,
  PROJECT,
  TestBrowser,
  clipIn,
  clipName,
  filesOf,
  fixture,
  recovered,
  renameClip,
  run,
  type TestWindow,
} from "./folder-support.ts";

const LOCALE = "locales/en.json";
/** The clip that both the editor and the other program name. */
const SHARED_CLIP = "clip_title";
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

/** What the shared clip is named in the text of a timeline, where it can be read. */
function titleIn(text: string): string | undefined {
  try {
    return clipIn(JSON.parse(text), SHARED_CLIP)?.name;
  } catch {
    return undefined;
  }
}

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
  /**
   * What it named the clip that the editor names too, and when: a conflict, where the editor's side
   * stays and the folder's has to be kept in recovered.
   */
  readonly titles: { readonly name: string; readonly step: number }[] = [];
  /** What it named the clip and then wrote over itself, before anybody saw it: that is gone. */
  readonly overwritten = new Set<string>();
  step = 0;
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
    if (path === MAIN) {
      const at = this.#path(path);
      const before = this.#disk.has(at) ? titleIn(this.#disk.text(at)) : undefined;
      const after = titleIn(text);
      if (before !== undefined && before !== after) this.overwritten.add(before);
      if (after !== undefined) this.overwritten.delete(after);
    }
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
      if (this.#random.chance(0.3)) {
        const clip = clipIn(document, SHARED_CLIP);
        clip.name = this.#fresh();
        this.titles.push({ name: clip.name, step: this.step });
        return;
      }
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
  /** When it last named the clip that the other program names too. */
  titleStep = -1;
  step = 0;
  code = "";
  readonly #clips: readonly string[];

  constructor(random: Random, clips: readonly string[]) {
    this.#random = random;
    this.#clips = clips;
  }

  async act(window: TestWindow): Promise<string> {
    this.#count += 1;
    if (this.#random.chance(0.75)) {
      const clip = this.#random.chance(0.3)
        ? SHARED_CLIP
        : (this.#random.pick(this.#clips) as string);
      const name = `E${this.#count}`;
      renameClip(window.store, clip, name);
      this.names.set(clip, name);
      if (clip === SHARED_CLIP) this.titleStep = this.step;
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
export async function fuzzFolder(seed: number, steps = 150): Promise<void> {
  seedIds(seed);
  const random = randomFrom(seed);
  const system = random.chance(0.5) ? "windows" : "linux";
  const files = fixture();
  for (const [path, text] of Object.entries(OTHERS)) files.set(path, text);
  const browser = new TestBrowser({ system }, files);
  // A browser can tell late that a window waits, and a window that slept late that it lost.
  browser.disk.turns.lateWaiting = random.chance(0.5);
  browser.disk.turns.lateLost = random.chance(0.5);
  const outside = new Outside(browser, random);
  /** Every name the shared clip had in any window, to tell what came in from what got lost. */
  const seen = new Set<string>();
  const open = async () => {
    const window = await browser.open();
    const look = () => {
      const name = clipName(window.store, SHARED_CLIP);
      if (name !== undefined) seen.add(name);
    };
    look();
    window.store.subscribe(look);
    return window;
  };
  // Now and then the window that makes the project from the folder keeps nothing in its first turn:
  // the browser's database fails, so it lets go, and another window writes before it is back.
  const keepsNothingFirst = random.chance(0.3);
  if (keepsNothingFirst) browser.faults.bases = true;
  const first = await open();
  const main = first.store.getState().timelines["main"];
  // A locked track keeps its clips from the editor too.
  const clips = Object.values(main?.clips ?? {})
    .filter(({ track, id }) => main?.tracks[track]?.locked !== true && id !== SHARED_CLIP)
    .map(({ id }) => id);
  const editor = new Editor(random, clips);
  if (keepsNothingFirst) {
    browser.faults.bases = false;
    await open();
  } else if (random.chance(0.5)) await open();
  const said: string[] = keepsNothingFirst ? ["first keeps nothing"] : [];
  const live = () => browser.windows.filter(isAlive);
  /** Crashes at a write wait for that write: in the end there is none any more. */
  let canCrash = true;
  /** Files where the next write is taken back. */
  const takingBack = new Set<string>();
  const crash = () => {
    if (canCrash) browser.crash();
  };

  for (let step = 0; step < steps; step++) {
    editor.step = step;
    outside.step = step;
    const roll = random.int(100);
    const windows = live();
    if (roll < 3) {
      // The database of the browser fails for a while, or works again.
      browser.faults.bases = !browser.faults.bases;
      said.push(`bases ${browser.faults.bases ? "fail" : "work"}`);
    } else if (roll < 6) {
      // Another program holds on to a file, or lets go.
      const path = random.pick([MAIN, NOTES, CODE, EDITOR_CODE]) as string;
      if (browser.faults.unreadable.has(path)) browser.faults.unreadable.delete(path);
      else browser.faults.unreadable.add(path);
      said.push(`unreadable ${path}`);
    } else if (roll < 9) {
      // The power goes right after a write, and the system takes the write back: the file before
      // is there again, time and all. What the file was before the write that lands is what comes
      // back, also when writes before it did not get that far. A file that a write makes is
      // empty at first, as one that was empty already: those are left to session-edges.test.ts.
      const path = random.pick([MAIN, CODE, EDITOR_CODE]) as string;
      const at = `${outside.root}/${path}`;
      // One at a time: for two, the writes that do not land would not be looked at by both.
      if (takingBack.has(at)) said.push("skip");
      else {
        takingBack.add(at);
        let before: { bytes: Uint8Array; time: number } | undefined;
        let takeBack = () => {};
        const look = () => {
          const bytes = browser.disk.has(at) ? browser.disk.bytes(at) : new Uint8Array();
          before = bytes.length > 0 ? { bytes, time: browser.disk.lastModified(at) } : undefined;
          takeBack = browser.disk.onNext("createWritable", at, look);
        };
        takeBack = browser.disk.onNext("createWritable", at, look);
        browser.disk.onNext("written", at, () => {
          takeBack();
          takingBack.delete(at);
          const was = before;
          if (!canCrash || !was) return;
          queueMicrotask(() => {
            if (!canCrash) return;
            browser.crash();
            browser.disk.write(at, was.bytes, { quietly: true, lastModified: was.time });
          });
        });
        said.push(`taken back ${path}`);
      }
    } else if (roll < 37) {
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
        await open();
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
      await open();
      if (random.chance(0.3)) await open();
    }
    await browser.settle(random.pick([0, 200, 700, 1200, 3000, 6000]) as number);
  }

  // People stop, and everything gets the time it needs.
  canCrash = false;
  outside.tidy();
  browser.disk.missesChanges = false;
  browser.faults.bases = false;
  browser.faults.unreadable.clear();
  for (const window of live()) browser.disk.sleep(window.folders, false);
  if (live().length === 0) await open();
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
  for (const [clip, name] of editor.names) {
    if (clip !== SHARED_CLIP) expect(clipName(store, clip), `${context}: ${clip}`).toBe(name);
  }
  // The clip both named: the one who named it last wins, or the editor where both did at once.
  const last = outside.titles.at(-1);
  const named = clipName(store, SHARED_CLIP);
  const editorName = editor.names.get(SHARED_CLIP);
  if (last && last.step >= editor.titleStep) {
    expect([editorName, last.name], `${context}: ${SHARED_CLIP}`).toContain(named);
  } else if (editorName !== undefined) {
    expect(named, `${context}: ${SHARED_CLIP}`).toBe(editorName);
  }
  // Nothing the other program named it got lost: it came in, or it is kept in recovered.
  const kept = [...recovered(browser.disk).values()].flat().join("\n");
  for (const { name } of outside.titles) {
    if (outside.overwritten.has(name) && !seen.has(name)) continue;
    expect(seen.has(name) || kept.includes(`"${name}"`), `${context}: ${name}`).toBe(true);
  }
  if (editor.code !== "") expect(store.getState().files[EDITOR_CODE], context).toBe(editor.code);
  // What the other program did is all there, and only once.
  const state = store.getState();
  if (outside.note !== undefined) {
    expect(state.notes?.["note_1"]?.text, `${context}: note`).toBe(outside.note);
  }
  for (const [id, name] of outside.markers) {
    expect(state.timelines["main"]?.markers[id]?.name, `${context}: ${id}`).toBe(name);
  }
  for (const [key, text] of outside.strings) {
    expect(state.locales["en"]?.[key]?.text, `${context}: ${key}`).toBe(text);
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
