import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProject, writeProject, type SoundManifest } from "@animaquill/schema";
import type { Page } from "@playwright/test";
import { openFile, replaceAll, save } from "./code-support.ts";
import { typeInto } from "./property-helpers.ts";
import { clickFirstClip, importFolder, sceneFrames } from "./scene-support.ts";
import {
  content,
  createProject as createInEditor,
  expect,
  needsDevPage,
  tab,
  test,
} from "./support.ts";

// Making a sound starts a page and a worker, which takes its time on a busy computer.
test.describe.configure({ timeout: 90_000 });

const timeline = (page: Page) => content(page, "timeline");
const clips = (page: Page) => timeline(page).getByRole("option");
const items = (page: Page) => content(page, "assets").getByRole("listitem");
const button = (page: Page, name: string) =>
  content(page, "preview").getByRole("button", { name, exact: true });

/** A clip with a sound that has this code, on a track for sound. */
interface SoundClip {
  readonly sound?: string;
  readonly start?: string;
  readonly duration?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** Writes a project with sounds to a folder, the way somebody could with an editor of their own. */
function soundFolder(
  sounds: Readonly<Record<string, string>>,
  list: readonly SoundClip[],
  extra: Readonly<Record<string, string>> = {},
): string {
  const manifests = Object.keys(sounds).map((id): [string, SoundManifest] => [
    id,
    { name: `声音 ${id}`, entry: "sound.js", runtime: 1 },
  ]);
  const project = { ...createProject({ name: "声音项目" }), sounds: new Map(manifests) };
  const files = writeProject(project);
  const path = "timelines/main/timeline.json";
  const main = JSON.parse(files.get(path) as string) as {
    sections: { duration: string }[];
    tracks: unknown[];
  };
  main.sections = main.sections.map((section) => ({ ...section, duration: "30" }));
  main.tracks.push({
    id: "voice",
    kind: "audio",
    clips: list.map((clip, index) => ({
      id: `clip${index}`,
      name: `声音 ${clip.sound ?? Object.keys(sounds)[0]}`,
      start: clip.start ?? "0",
      duration: clip.duration ?? "2",
      source: { kind: "sound", sound: clip.sound ?? Object.keys(sounds)[0] },
      properties: clip.properties ?? { "param.duration": 2 },
    })),
  });
  files.set(path, JSON.stringify(main));
  for (const [id, code] of Object.entries(sounds)) files.set(`sounds/${id}/sound.js`, code);
  for (const [name, text] of Object.entries(extra)) files.set(name, text);
  const root = join(mkdtempSync(join(tmpdir(), "animaquill-sound-")), "项目");
  for (const [name, text] of files) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const SINE = `aq.sound(({ frames, sampleRate }) => {
  const samples = new Float32Array(frames);
  for (let at = 0; at < frames; at += 1) {
    samples[at] = 0.5 * Math.sin((2 * Math.PI * 440 * at) / sampleRate);
  }
  return samples;
});`;

/** Everything that would differ between two runs if it were not for the seed and the clock. */
const RANDOM = `aq.sound(({ frames, seed }) => {
  const samples = new Float32Array(frames);
  const moment = Date.now() + performance.now();
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  for (let at = 0; at < frames; at += 1) samples[at] = Math.random() - 0.5;
  samples[0] = (seed % 100) / 100;
  samples[1] = (moment % 1000) / 1000;
  samples[2] = bytes[0] / 255;
  return samples;
});`;

interface Stored {
  readonly name: string;
  readonly size: number;
  /** The bytes of the samples, as text to compare. */
  readonly digest: string;
}

/** What code made so far, as far as it is in the media store. */
const storedSounds = (page: Page) =>
  page.evaluate(async (): Promise<Stored[]> => {
    const records = await new Promise<{ hash: string; file: Blob }[]>((resolve, reject) => {
      const open = indexedDB.open("animaquill");
      open.addEventListener("error", () => reject(open.error));
      open.addEventListener("success", () => {
        const read = open.result.transaction("media").objectStore("media").getAll();
        read.addEventListener("success", () => {
          open.result.close();
          resolve(read.result as { hash: string; file: Blob }[]);
        });
      });
    });
    const sounds = records.filter(({ hash }) => hash.startsWith("sound-"));
    return Promise.all(
      sounds.map(async ({ hash, file }) => {
        const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        const digestText = [...new Uint8Array(digest)].map((byte) => byte.toString(16)).join("");
        return { name: hash, size: file.size, digest: digestText };
      }),
    );
  });

const forget = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("animaquill");
        open.addEventListener("error", () => reject(open.error));
        open.addEventListener("success", () => {
          const transaction = open.result.transaction("media", "readwrite");
          const media = transaction.objectStore("media");
          const all = media.getAllKeys();
          all.addEventListener("success", () => {
            for (const key of all.result as [string, string][]) {
              if (key[1].startsWith("sound-")) media.delete(key);
            }
          });
          transaction.addEventListener("complete", () => {
            open.result.close();
            resolve();
          });
        });
      }),
  );

/** How many pages code has been running on, since this got called. */
function countRuns(page: Page) {
  let runs = 0;
  page.on("framenavigated", (frame) => {
    if (frame.url().includes("/scene.html")) runs += 1;
  });
  return () => runs;
}

/** Keeps what gets played, to be able to say what it sounded like. */
const hearEverything = (page: Page) =>
  page.addInitScript(() => {
    if (window !== window.top) return;
    const { start } = AudioBufferSourceNode.prototype;
    const ears = window as unknown as { heard: { peak: number; channels: number; rate: number }[] };
    ears.heard = [];
    AudioBufferSourceNode.prototype.start = function hear(...args) {
      const { buffer } = this;
      let peak = 0;
      for (const sample of buffer?.getChannelData(0) ?? []) peak = Math.max(peak, Math.abs(sample));
      ears.heard.push({
        peak,
        channels: buffer?.numberOfChannels ?? 0,
        rate: buffer?.sampleRate ?? 0,
      });
      start.apply(this, args);
    };
  });

/** Keeps what the gains of the sound were when something starts playing. */
async function gainsPlayed(page: Page, start: () => Promise<void>): Promise<readonly number[]> {
  await page.evaluate(() => {
    const ears = window as unknown as { gains: GainNode[] };
    ears.gains = [];
    const { createGain } = AudioContext.prototype;
    AudioContext.prototype.createGain = function keep() {
      const node = createGain.call(this);
      ears.gains.push(node);
      return node;
    };
  });
  await start();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { gains: GainNode[] }).gains.length))
    .toBeGreaterThan(0);
  return page.evaluate(() =>
    (window as unknown as { gains: GainNode[] }).gains.map(
      ({ gain }) => Math.round(gain.value * 1e6) / 1e6,
    ),
  );
}

const heard = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { heard: { peak: number; channels: number; rate: number }[] }).heard,
  );

/** What the page warned about, for saying why a sound did not come about. */
const warnings = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const list: string[] = [];
  warnings.set(page, list);
  page.on("console", (message) => {
    if (message.type() === "warning") list.push(message.text());
  });
});

const toldOf = async (page: Page) =>
  `${(await page.locator("body").innerText()).slice(-300)}\n${(warnings.get(page) ?? []).join("\n")}`;

/** Waits for so many sounds in the store, and says what the editor told people when they do not come. */
async function waitForStored(page: Page, count: number) {
  try {
    await expect
      .poll(async () => (await storedSounds(page)).length, { timeout: 30_000 })
      .toBe(count);
  } catch (error) {
    const labels = await clips(page).evaluateAll((all) => all.map((clip) => clip.ariaLabel));
    throw new Error(`${String(error)}\n${labels.join("\n")}\n${await toldOf(page)}`, {
      cause: error,
    });
  }
}

/** Says what the editor told people when it is not, which is what to go on when this fails. */
async function isReady(page: Page, name: string) {
  const ready = new RegExp(`^${name}，`);
  const label = () => clips(page).first().getAttribute("aria-label");
  await expect
    .poll(async () => ready.test((await label()) ?? "") || /生成失败/.test((await label()) ?? ""), {
      timeout: 20_000,
    })
    .toBe(true);
  expect(await label(), await toldOf(page)).toMatch(ready);
}

/** Changes the code of a sound in the code editor, the way people do. */
async function writeCode(page: Page, text: string): Promise<void> {
  await openFile(page, "sound.js");
  await replaceAll(page, text);
  // The editor closes brackets as they come, after the cursor, which people would not type.
  await page.keyboard.press("Control+Shift+End");
  await page.keyboard.press("Delete");
  await save(page);
}

/** Presses at one point and moves to another with real mouse events, then lets go. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 8 });
  await page.mouse.up();
}

/** Waits for what the timeline says about a clip to change, and gives where it is now. */
async function changed(page: Page, before: string | null) {
  await expect(clips(page).first()).not.toHaveAttribute("aria-label", before ?? "");
  const box = await clips(page).first().boundingBox();
  if (!box) throw new Error("No clip");
  return { ...box, label: await clips(page).first().getAttribute("aria-label") };
}

/** Not every message is about what is being tested. These are what a blocked request looks like. */
const withoutBlocked = (problems: string[]) => {
  const rest = problems.filter((text) => !/Content Security Policy|CSP violation/.test(text));
  problems.splice(0, problems.length, ...rest);
};

/**
 * The colour just inside the top border of a clip, and the one on its middle line, both past where
 * its name is. Bars of a waveform always reach the middle line, and nothing else does.
 */
async function waveformProbe(page: Page) {
  const box = await clips(page).first().boundingBox();
  const canvas = timeline(page).locator("canvas");
  const area = await canvas.boundingBox();
  if (!box || !area) throw new Error("No box");
  return canvas.evaluate(
    (element: HTMLCanvasElement, { left, top, inner }) => {
      const ratio = element.width / element.clientWidth;
      const context = element.getContext("2d");
      const colour = (at: number) =>
        [...(context?.getImageData(left * ratio, at * ratio, 1, 1).data ?? [])].join();
      return [colour(top + 5), colour(top + inner / 2)];
    },
    { left: box.x - area.x + box.width * 0.6, top: box.y - area.y, inner: box.height },
  );
}

const hasWaveform = async (page: Page) => {
  const [edge, inside] = await waveformProbe(page);
  return edge !== inside;
};

test.describe("a new sound", () => {
  test("can be heard without writing any code", async ({ page }) => {
    await hearEverything(page);
    await page.reload();
    await content(page, "assets").getByRole("button", { name: "新建声音" }).click();
    await expect(clips(page)).toHaveCount(1);
    await isReady(page, "声音 1");
    await expect.poll(() => hasWaveform(page)).toBe(true);
    await expect(items(page).filter({ hasText: "声音 1" })).toBeVisible();
    await button(page, "播放").click();
    await expect.poll(async () => (await heard(page)).length).toBeGreaterThan(0);
    // On a busy computer the start can be late and left out, and bells fade.
    const all = await heard(page);
    expect(Math.max(...all.map(({ peak }) => peak))).toBeGreaterThan(0.01);
    expect(all[0]?.channels).toBe(2);
    await button(page, "暂停").click();
  });

  test("goes on the timeline in one step, and goes when that is undone", async ({ page }) => {
    await content(page, "assets").getByRole("button", { name: "新建声音" }).click();
    await expect(clips(page)).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expect(clips(page)).toHaveCount(0);
    await expect(items(page)).toHaveCount(0);
  });

  test("offers its volume, and people hear what they are trying", async ({ page }) => {
    await hearEverything(page);
    await page.reload();
    await content(page, "assets").getByRole("button", { name: "新建声音" }).click();
    await isReady(page, "声音 1");
    const volume = content(page, "properties").getByRole("spinbutton", { name: "音量" });
    await typeInto(volume, "-60");
    expect(await gainsPlayed(page, () => button(page, "播放").click())).toEqual([0.001]);
    await button(page, "暂停").click();
  });
});

test.describe("a sound from a folder", () => {
  test.use({ withProject: false });

  test("plays what the code made, sample by sample", async ({ page }) => {
    await hearEverything(page);
    await page.reload();
    await importFolder(page, soundFolder({ a: SINE }, [{}]));
    await isReady(page, "声音 a");
    const [stored] = await storedSounds(page);
    // Two seconds of one channel of 32-bit floats, and what a file says about that.
    expect(stored?.size).toBe(44 + 2 * 48_000 * 4);
    await button(page, "播放").click();
    await expect.poll(async () => (await heard(page)).length).toBeGreaterThan(0);
    const [first] = await heard(page);
    expect(first?.peak).toBeCloseTo(0.5, 2);
    expect(first?.channels).toBe(1);
    expect(first?.rate).toBe(48_000);
    await button(page, "暂停").click();
  });

  test("can go on the timeline from the list", async ({ page }) => {
    await importFolder(page, soundFolder({ a: SINE }, []));
    await expect(clips(page)).toHaveCount(0);
    await items(page).filter({ hasText: "声音 a" }).dblclick();
    await expect(clips(page)).toHaveCount(1);
    await isReady(page, "声音 a");
    await expect.poll(() => hasWaveform(page)).toBe(true);
  });

  test("can use code it shares with others", async ({ page }) => {
    await hearEverything(page);
    await page.reload();
    const code = `import { level } from "../../code/level.js";
      aq.sound(({ frames }) => new Float32Array(frames).fill(level));`;
    const shared = { "code/level.js": "export const level = 0.25;" };
    await importFolder(page, soundFolder({ a: code }, [{}], shared));
    await isReady(page, "声音 a");
    await button(page, "播放").click();
    await expect.poll(async () => (await heard(page)).length).toBeGreaterThan(0);
    expect((await heard(page))[0]?.peak).toBe(0.25);
    await button(page, "暂停").click();
  });

  test("gets its parameters and its seed", async ({ page }) => {
    await hearEverything(page);
    await page.reload();
    const code = `aq.sound(({ frames, params, seed }) =>
      new Float32Array(frames).fill(params.level + seed / 1000));`;
    const properties = { "param.duration": 1, "param.level": 0.5, "param.seed": 100 };
    await importFolder(page, soundFolder({ a: code }, [{ properties }]));
    await isReady(page, "声音 a");
    await button(page, "播放").click();
    await expect.poll(async () => (await heard(page)).length).toBeGreaterThan(0);
    expect((await heard(page))[0]?.peak).toBeCloseTo(0.6, 5);
    await button(page, "暂停").click();
  });

  test("comes out the same every time, whatever else is going on", async ({ page }) => {
    await importFolder(page, soundFolder({ a: RANDOM }, [{}]));
    await isReady(page, "声音 a");
    const [first] = await storedSounds(page);
    await forget(page);
    await page.reload();
    await expect(clips(page)).toHaveCount(1);
    await waitForStored(page, 1);
    const [second] = await storedSounds(page);
    expect(second).toEqual(first);
  });

  test("comes out differently with another seed", async ({ page }) => {
    const seeded = (seed: number) => ({
      start: String(seed * 3),
      properties: { "param.duration": 2, "param.seed": seed },
    });
    await importFolder(page, soundFolder({ a: RANDOM }, [seeded(1), seeded(2)]));
    await waitForStored(page, 2);
    const [first, second] = await storedSounds(page);
    expect(first?.digest).not.toBe(second?.digest);
  });

  test("is not made again after a reload", async ({ page }) => {
    await importFolder(page, soundFolder({ a: SINE }, [{}]));
    await isReady(page, "声音 a");
    const runs = countRuns(page);
    await page.reload();
    await expect(clips(page)).toHaveCount(1);
    await isReady(page, "声音 a");
    await expect.poll(() => hasWaveform(page)).toBe(true);
    expect(runs()).toBe(0);
  });

  test("is made once for clips that sound the same", async ({ page }) => {
    const runs = countRuns(page);
    await importFolder(page, soundFolder({ a: SINE }, [{}, { start: "5" }]));
    await isReady(page, "声音 a");
    await waitForStored(page, 1);
    expect(runs()).toBe(1);
  });

  test("is made again when the code changes", async ({ page }) => {
    await importFolder(page, soundFolder({ a: SINE }, [{}]));
    await isReady(page, "声音 a");
    const runs = countRuns(page);
    await writeCode(page, SINE.replace("0.5 *", "0.25 *"));
    await waitForStored(page, 2);
    expect(runs()).toBe(1);
    const [first, second] = await storedSounds(page);
    expect(first?.digest).not.toBe(second?.digest);
  });

  test("keeps its samples when the clip gets trimmed, cut or moved", async ({ page }) => {
    await importFolder(page, soundFolder({ a: SINE }, [{}]));
    await isReady(page, "声音 a");
    const runs = countRuns(page);
    // Trimmed at the start, moved and cut, the way people do it.
    let clip = await changed(page, null);
    const middle = clip.y + clip.height / 2;
    await drag(page, [clip.x + 2, middle], [clip.x + clip.width / 3, middle]);
    clip = await changed(page, clip.label);
    await drag(page, [clip.x + clip.width / 2, middle], [clip.x + clip.width * 2, middle]);
    clip = await changed(page, clip.label);
    await timeline(page).getByRole("group", { name: "时间轴" }).focus();
    await page.keyboard.press("c");
    await page.mouse.click(clip.x + clip.width / 2, middle);
    await page.keyboard.press("v");
    await expect(clips(page)).toHaveCount(2);
    await page.waitForTimeout(1000);
    expect(runs()).toBe(0);
    await waitForStored(page, 1);
  });
});

test.describe("a sound that is not there yet", () => {
  test.use({ withProject: false });

  const SLOW = `aq.sound(({ frames }) => {
    let sum = 0;
    for (let round = 0; round < 1e9; round += 1) sum += round % 3;
    return new Float32Array(frames).fill(sum > 0 ? 0.5 : 0);
  });`;

  test("shows that on its clip, does not hold up playing, and comes in on time", async ({
    page,
  }) => {
    await hearEverything(page);
    await page.reload();
    const properties = { "param.duration": 25 };
    await importFolder(page, soundFolder({ a: SLOW }, [{ duration: "25", properties }]));
    await expect(clips(page).first()).toHaveAttribute("aria-label", /声音 a · 正在生成/);
    await button(page, "播放").click();
    const clock = content(page, "preview").getByRole("toolbar");
    const shown = await clock.textContent();
    await expect.poll(() => clock.textContent()).not.toBe(shown);
    await expect(clips(page).first()).toHaveAttribute("aria-label", /声音 a · 正在生成/);
    expect(await heard(page)).toEqual([]);
    await isReady(page, "声音 a");
    await expect.poll(async () => (await heard(page)).length, { timeout: 5000 }).toBeGreaterThan(0);
    await button(page, "暂停").click();
  });
});

test.describe("code that means harm", () => {
  test.use({ withProject: false });

  /**
   * Time is up early here. Waiting a whole minute proves no more, and only the development page can
   * be told to: what needs that does not run against the site.
   */
  const importQuickly = async (page: Page, folder: string) => {
    await page.goto("/?soundLimit=1500");
    await importFolder(page, folder);
  };
  const SOUND_LIMIT = "?soundLimit=, which makes time run out early";

  const failed = (page: Page, index = 0) =>
    expect(clips(page).nth(index)).toHaveAttribute("aria-label", /生成失败/, { timeout: 20_000 });

  /** The playhead moves, and a picture comes out of the compositor: nothing here got stuck. */
  async function stillWorks(page: Page) {
    await button(page, "播放").click();
    const clock = content(page, "preview").getByRole("toolbar");
    const shown = await clock.textContent();
    await expect.poll(() => clock.textContent()).not.toBe(shown);
    await button(page, "暂停").click();
  }

  const CASES: readonly (readonly [string, string, RegExp])[] = [
    ["a loop that never ends", "for (;;) {}", /算了太久/],
    ["a loop that never ends in its sound", "aq.sound(() => { for (;;) {} });", /算了太久/],
    ["a promise that never ends", "aq.sound(() => new Promise(() => {}));", /算了太久/],
    [
      "more samples than it was asked for",
      "aq.sound(({ frames }) => new Float32Array(frames * 100));",
      /比要求的时长更长/,
    ],
    [
      "more channels than there are",
      "aq.sound(({ frames }) => [1, 2, 3].map(() => new Float32Array(frames)));",
      /不是声音/,
    ],
    [
      "channels that do not fit",
      "aq.sound(({ frames }) => [new Float32Array(frames), new Float32Array(1)]);",
      /不是声音/,
    ],
    ["something else than samples", 'aq.sound(() => "声音");', /不是声音/],
    ["a list of numbers", "aq.sound(() => [[0.5, 0.5]]);", /不是声音/],
    ["nothing", "aq.sound(() => new Float32Array(0));", /不是声音/],
    [
      "a flood of messages",
      "for (let i = 0; i < 1e6; i += 1) postMessage({ type: 'x' }); aq.sound(() => new Promise(() => {}));",
      /消息太多/,
    ],
    [
      "large messages of its own",
      "const big = new Float32Array(4e6); for (let i = 0; i < 1e4; i += 1) postMessage({ type: 'x', big }); aq.sound(() => new Promise(() => {}));",
      /消息太多|算了太久/,
    ],
    ["no sound at all", "const a = 1;", /没有调用 aq\.sound/],
    ["an error", 'aq.sound(() => { throw new Error("坏了"); });', /坏了/],
    ["code that does not parse", "aq.sound(((( ;", /代码出错/],
  ];

  for (const [name, code, says] of CASES) {
    test(`does nothing to the editor: ${name}`, async ({ page, devPage }) => {
      test.skip(!devPage && says.source === "算了太久", needsDevPage(SOUND_LIMIT));
      const good = `aq.sound(({ frames }) => new Float32Array(frames).fill(0.5));`;
      const folder = soundFolder({ bad: code, good }, [{}, { sound: "good", start: "5" }]);
      await importQuickly(page, folder);
      await failed(page);
      await expect(page.getByText(says).first()).toBeVisible();
      // What came next got made, and on a site that is still usable.
      await expect(clips(page).nth(1)).toHaveAttribute("aria-label", /^声音 good，/, {
        timeout: 20_000,
      });
      await stillWorks(page);
      expect(sceneFrames(page)).toHaveLength(0);
    });
  }

  test("does not get to the network", async ({ page, problems }) => {
    const code = `aq.sound(async ({ frames }) => {
      const answer = await fetch("http://localhost:5173/").then(() => 1, () => 0);
      return new Float32Array(frames).fill(answer * 0.5);
    });`;
    await hearEverything(page);
    await importQuickly(page, soundFolder({ a: code }, [{}]));
    await isReady(page, "声音 a");
    await button(page, "播放").click();
    await expect.poll(async () => (await heard(page)).length).toBeGreaterThan(0);
    expect((await heard(page))[0]?.peak).toBe(0);
    await button(page, "暂停").click();
    withoutBlocked(problems);
  });

  test("gets another chance when the code changes", async ({ page, devPage }) => {
    test.skip(!devPage, needsDevPage(SOUND_LIMIT));
    await importQuickly(page, soundFolder({ a: "for (;;) {}" }, [{}]));
    await failed(page);
    await writeCode(page, SINE);
    await isReady(page, "声音 a");
  });

  test("does not cost the sites scenes run on", async ({ page, devPage }) => {
    test.skip(!devPage, needsDevPage(SOUND_LIMIT));
    const loop = "for (;;) {}";
    const sounds = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`s${index}`, `${loop} // ${index}`]),
    );
    const good = SINE;
    const list = Object.keys(sounds).map((sound, index) => ({ sound, start: String(index * 3) }));
    const folder = soundFolder({ ...sounds, good }, [
      ...list,
      { sound: "good", start: String(list.length * 3) },
    ]);
    await page.goto("/?soundLimit=200");
    await importFolder(page, folder);
    await expect(clips(page).nth(list.length)).toHaveAttribute("aria-label", /^声音 good，/, {
      timeout: 40_000,
    });
  });
});

test.describe("a sound that failed", () => {
  test.use({ withProject: false });

  test("can be tried again from its properties, without changing anything", async ({ page }) => {
    const code = 'aq.sound(() => { throw new Error("又坏了"); });';
    await importFolder(page, soundFolder({ a: code }, [{}]));
    await expect(clips(page).first()).toHaveAttribute("aria-label", /生成失败/, {
      timeout: 20_000,
    });
    await clickFirstClip(page);
    await tab(page, "properties").click();
    const retry = content(page, "properties").getByRole("button", { name: "重试" });
    await expect(retry).toBeVisible();
    const runs = countRuns(page);
    await retry.click();
    await expect.poll(runs, { timeout: 20_000 }).toBe(1);
    await expect(clips(page).first()).toHaveAttribute("aria-label", /生成失败/, {
      timeout: 20_000,
    });
  });
});

/** Writes a file straight into the media store of a project, as if it had been there a long time. */
const plant = (page: Page, name: string, bytes: number, usedAt?: number) =>
  page.evaluate(
    ([hash, size, used]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("animaquill");
        open.addEventListener("error", () => reject(open.error));
        open.addEventListener("success", () => {
          const transaction = open.result.transaction("media", "readwrite");
          const media = transaction.objectStore("media");
          const all = media.getAll();
          all.addEventListener("success", () => {
            const [sound] = (all.result as { project: string; hash: string }[]).filter((record) =>
              record.hash.startsWith("sound-"),
            );
            const record = {
              project: sound?.project,
              hash,
              file: new Blob([new Uint8Array(size)]),
            };
            media.put(used === null ? record : { ...record, usedAt: used });
          });
          transaction.addEventListener("complete", () => {
            open.result.close();
            resolve();
          });
        });
      }),
    [name, bytes, usedAt ?? null] as const,
  );

const allStored = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const open = indexedDB.open("animaquill");
        open.addEventListener("success", () => {
          const read = open.result.transaction("media").objectStore("media").getAllKeys();
          read.addEventListener("success", () => {
            open.result.close();
            resolve((read.result as [string, string][]).map(([, hash]) => hash).toSorted());
          });
        });
      }),
  );

test.describe("sounds nobody needs", () => {
  test.use({ withProject: false });

  test("go when the project opens, and nothing people brought in goes along", async ({ page }) => {
    await importFolder(page, soundFolder({ a: SINE }, [{}]));
    await isReady(page, "声音 a");
    const [current] = await storedSounds(page);
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    await plant(page, "sound-1:stale", 1000, longAgo);
    await plant(page, "peaks-1:sound-1:stale", 10, longAgo);
    // Never used as far as anybody knows, which is as old as it gets, and in no clip: it stays.
    await plant(page, "sha256-brought-in=", 1000);
    await plant(page, "peaks-1:sha256-brought-in=", 10);
    await page.reload();
    await isReady(page, "声音 a");
    await expect
      .poll(() => allStored(page))
      .toEqual(
        [
          current?.name,
          `peaks-1:${current?.name}`,
          "sha256-brought-in=",
          "peaks-1:sha256-brought-in=",
        ]
          .map(String)
          .toSorted(),
      );
  });
});

test.describe("a project that goes away", () => {
  test("takes its sound along", async ({ page }) => {
    await content(page, "assets").getByRole("button", { name: "新建声音" }).click();
    await isReady(page, "声音 1");
    await page.goto("/");
    await createInEditor(page, "另一个");
    await expect(clips(page)).toHaveCount(0);
  });
});
