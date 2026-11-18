import { readFileSync } from "node:fs";
import type { MixSound, MixTrack, SoundFade } from "@animaquill/core";
import { mixOfCase, type MixCase } from "../../audio/src/engine/test-support.ts";
import type { Page } from "@playwright/test";
import { devPageOnly, expect, test } from "./support.ts";

/**
 * The mix engine against what it took over from, and the preview against the export (audio-mixing.md
 * 4 and 6 of AnimaQuill Cloud, M1). The engine must not change the sound of a project: files at
 * 48 kHz mix as the browser mixed them before, up to the last bit of a 32-bit float; other rates
 * within −60 dB, because the engine resamples itself now. And the preview, in the audio thread, gives
 * the same samples as the export.
 */

test.use({ withProject: false });
devPageOnly("window.aqAudio and window.aqOldMixer");

/** What the page has for these tests, see `dev/main.tsx`. */
interface Lab {
  aqAudio: () => Promise<typeof import("../../audio/src/index.ts")>;
  aqOldMixer: () => Promise<typeof import("../dev/old-mixer.ts")>;
  aqMixerModule: () => Promise<string>;
  aqMixLab: () => Promise<typeof import("../../audio/src/engine/test-support.ts")>;
}

/** Plans with files made of signals, and the hashes of their mix (schema/fixtures/mix). */
const { cases: FIXED } = JSON.parse(
  readFileSync(new URL("../../schema/fixtures/mix/cases.json", import.meta.url), "utf8"),
) as { cases: MixCase[] };

/** How each case of the old mix and the engine's compare. */
interface Compared {
  readonly name: string;
  readonly rate: number;
  /** The largest difference, in units of the last place of a 32-bit float at the peak. */
  readonly ulps: number;
  /** The largest difference, in dB of full scale. */
  readonly db: number;
  /** The loudest sample, so that silence does not pass for a match. */
  readonly peak: number;
  /** Whether cutting the engine's mix into other pieces changed anything. */
  readonly cutsDiffer: number;
  readonly sounds: number;
}

/** Opens the development page, once it has what these tests use. */
async function open(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => "aqMixLab" in window);
}

test("the engine mixes existing projects as the browser did before it", async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  const compared = await page.evaluate(async (): Promise<Compared[]> => {
    const lab = window as unknown as Lab;
    const audio = await lab.aqAudio();
    const old = await lab.aqOldMixer();
    const SECONDS = 4;
    /**
     * A file of `channels` channels at `rate`, with tones in each, and at 48 kHz a high one and a
     * little noise too. Before the engine, the browser brought other rates to 48 kHz by drawing a
     * straight line between two samples, which takes off a little of high sounds, and it put a
     * click at the end of every chunk it decoded: the engine resamples properly, so the two differ
     * by that much. Low tones show where the engine puts each sample, which is what matters here.
     */
    const file = async (rate: number, channels: number, seed: number) => {
      const frames = SECONDS * rate;
      const samples = new Float32Array(frames * channels);
      const rich = rate === audio.MIX_SAMPLE_RATE;
      let noise = seed;
      for (let channel = 0; channel < channels; channel += 1) {
        for (let index = 0; index < frames; index += 1) {
          noise = (noise * 1_103_515_245 + 12_345) % 2_147_483_648;
          const t = index / rate;
          const low = 0.25 * Math.sin(2 * Math.PI * (110 + 55 * channel + seed) * t);
          const high = rich
            ? 0.1 * Math.sin(2 * Math.PI * (3000 + seed) * t) + 0.02 * (noise / 2_147_483_648 - 0.5)
            : 0;
          samples[channel * frames + index] = low + high;
        }
      }
      return audio.wavOf(new Blob([samples]), channels, frames, rate);
    };
    type Sound = MixSound;
    type Track = MixTrack;
    type Fade = SoundFade;
    const fade = (part: Omit<Fade, "duration">): Fade => ({
      ...part,
      duration: part.end - part.start,
    });
    const gain = (db: number) => 10 ** (db / 20);
    const track = (id: string, db = 0): Track => ({
      id,
      gain: gain(db),
      muted: false,
      solo: false,
    });
    const sound = (changes: Partial<Sound> & Pick<Sound, "id" | "file">): Sound => ({
      track: "t",
      start: 0,
      end: SECONDS,
      offset: 0,
      gain: 1,
      ...changes,
    });
    interface Case {
      readonly name: string;
      readonly rate: number;
      readonly sounds: Sound[];
      readonly tracks: Track[];
    }
    const cases = (rate: number): Case[] => [
      {
        name: "transitions",
        rate,
        tracks: [track("t")],
        sounds: [
          sound({
            id: "a",
            file: "stereo",
            start: 0.5,
            end: 3.5,
            offset: 0.2,
            gain: gain(-3),
            fades: [
              fade({ use: "enter", way: "in", shape: "power", start: 0.5, end: 1 }),
              fade({ use: "exit", way: "out", shape: "gain", start: 3, end: 3.5 }),
            ],
          }),
        ],
      },
      {
        name: "cross-fade",
        rate,
        tracks: [track("t")],
        sounds: [
          sound({
            id: "a",
            file: "stereo",
            end: 2.25,
            fades: [fade({ use: "join", way: "out", shape: "power", start: 1.75, end: 2.25 })],
          }),
          sound({
            id: "b",
            file: "other",
            start: 1.75,
            offset: 0.4,
            fades: [fade({ use: "join", way: "in", shape: "power", start: 1.75, end: 2.25 })],
          }),
        ],
      },
      {
        name: "tracks over each other, mono and 5.1",
        rate,
        tracks: [track("t", -6), track("u")],
        sounds: [
          sound({ id: "a", file: "mono", start: 0.25, end: 3 }),
          sound({ id: "b", file: "stereo", track: "u", gain: gain(-2), end: 3.75 }),
          sound({ id: "c", file: "six", track: "u", gain: gain(3), start: 1, offset: 0.5 }),
        ],
      },
      {
        name: "a sound that code made",
        rate,
        tracks: [track("t")],
        sounds: [sound({ id: "a", file: "made", made: true, start: 0.3, end: 2.8, offset: 0.1 })],
      },
    ];
    const results: Compared[] = [];
    for (const rate of [48_000, 44_100]) {
      const files: Record<string, Blob> = {
        stereo: await file(rate, 2, 1),
        other: await file(rate, 2, 2),
        mono: await file(rate, 1, 3),
        six: await file(rate, 6, 4),
        made: await file(rate, 2, 5),
      };
      const fileOf = async (name: string) => (name === "made" ? undefined : files[name]);
      for (const { name, sounds, tracks } of cases(rate)) {
        const frames = SECONDS * audio.MIX_SAMPLE_RATE;
        // Before the engine, the gains of track and clip were one, from their decibels added up.
        const oldPlan = {
          sounds: sounds.map(({ track: id, ...rest }) => ({
            ...rest,
            gain: rest.gain * (tracks.find((each) => each.id === id)?.gain ?? 1),
          })),
        };
        const before = await new old.SoundMixer(oldPlan, {
          fileOf,
          source: async (layer) =>
            layer.made ? (from, to) => old.readSound(files.made as Blob, from, to) : undefined,
        }).mix(0, frames);
        const options = {
          fileOf,
          source: async (each: { made?: true }) => (each.made ? files.made : undefined),
        };
        const engine = new audio.SoundMixer({ sounds, tracks }, options);
        const after = await engine.mix(0, frames);
        // The same in pieces of a second and a half.
        const pieces = new audio.SoundMixer({ sounds, tracks }, options);
        const cut = [new Float32Array(frames), new Float32Array(frames)];
        for (let at = 0; at < frames; at += 72_000) {
          const piece = await pieces.mix(at / audio.MIX_SAMPLE_RATE, Math.min(72_000, frames - at));
          cut[0]?.set(piece.getChannelData(0), at);
          cut[1]?.set(piece.getChannelData(1), at);
        }
        // At other rates the browser played one sample more at the end of a sound, where it was
        // exactly at a sample: the engine ends a sound before the moment it ends, as at 48 kHz.
        const edges = new Set<number>();
        if (rate !== audio.MIX_SAMPLE_RATE) {
          for (const { start, end } of sounds) {
            for (const at of [start, end]) {
              const sample = Math.round(at * audio.MIX_SAMPLE_RATE);
              for (let near = sample - 1; near <= sample + 1; near += 1) edges.add(near);
            }
          }
        }
        let largest = 0;
        let peak = 0;
        let cutsDiffer = 0;
        for (let channel = 0; channel < 2; channel += 1) {
          const was = before.getChannelData(channel);
          const is = after.getChannelData(channel);
          const pieced = cut[channel] as Float32Array;
          for (let index = 0; index < frames; index += 1) {
            const a = was[index] ?? 0;
            const b = is[index] ?? 0;
            if (!edges.has(index)) largest = Math.max(largest, Math.abs(a - b));
            peak = Math.max(peak, Math.abs(a));
            if (pieced[index] !== b) cutsDiffer += 1;
          }
        }
        // The last place of a 32-bit float at the level of the loudest sample.
        const ulps = largest / 2 ** (Math.floor(Math.log2(peak)) - 23);
        results.push({
          name,
          rate,
          ulps,
          db: largest === 0 ? -Infinity : 20 * Math.log10(largest),
          peak,
          cutsDiffer,
          sounds: sounds.length,
        });
      }
    }
    return results;
  });
  for (const each of compared) {
    console.log(
      `${each.name} at ${each.rate} Hz: ${each.ulps.toFixed(2)} ulp, ${each.db.toFixed(1)} dB, ` +
        `peak ${each.peak.toFixed(3)}`,
    );
  }
  for (const { name, rate, ulps, db, peak, cutsDiffer, sounds } of compared) {
    expect(peak, name).toBeGreaterThan(0.1);
    expect(cutsDiffer, name).toBe(0);
    // One sound at a time is the same to the last bit. The browser added sounds up in an order of
    // its own, which changes from run to run: each sound more can be another last place off.
    if (rate === 48_000) expect(ulps, name).toBeLessThanOrEqual(Math.max(1, sounds));
    // Below the loudest sample by 60 dB: what drawing straight lines took off low tones.
    else expect(db - 20 * Math.log10(peak), name).toBeLessThan(-60);
  }
});

test("the preview plays what the export mixes, sample by sample", async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  // Sound starts once people did something on the page.
  await page.mouse.click(10, 10);
  const result = await page.evaluate(async () => {
    const lab = window as unknown as Lab;
    const audio = await lab.aqAudio();
    const url = await lab.aqMixerModule();
    const SECONDS = 3;
    const file = async (rate: number) => {
      const frames = SECONDS * rate;
      const samples = new Float32Array(frames * 2);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = 0.3 * Math.sin((index % frames) * 0.05 + (index >= frames ? 1 : 0));
      }
      return audio.wavOf(new Blob([samples]), 2, frames, rate);
    };
    const files: Record<string, Blob> = { a: await file(48_000), b: await file(44_100) };
    const plan = {
      tracks: [{ id: "t", gain: 0.8, muted: false, solo: false }],
      sounds: [
        {
          id: "a",
          file: "a",
          track: "t",
          start: 0,
          end: 3,
          offset: 0,
          gain: 0.5,
          fades: [
            { use: "exit", way: "out", shape: "power", start: 1.5, end: 2.5, duration: 1 },
          ] as const,
        },
        { id: "b", file: "b", track: "t", start: 0.5, end: 3, offset: 0.25, gain: 0.7 },
      ],
    };
    const fileOf = async (name: string) => files[name];
    const exported = await new audio.SoundMixer(plan, { fileOf }).mix(0, SECONDS * 48_000);
    const heard = new Map<number, [number, number]>();
    const notes: string[] = [];
    const context = new AudioContext({ sampleRate: 48_000 });
    const playback = new audio.PlaybackAudio({
      fileOf,
      onProblem: (problem) => notes.push(`problem ${problem}`),
      createContext: () => context,
      onNote: (kind, data) => notes.push(`${kind} ${JSON.stringify(data)}`),
      mixer: async (each) => {
        const mixer = await audio.createMixer(each, url);
        mixer.send({ kind: "capture", on: true });
        mixer.listen((report) => {
          if (report.kind !== "captured") return;
          for (let index = 0; index < report.left.length; index += 1) {
            heard.set(report.sample + index, [report.left[index] ?? 0, report.right[index] ?? 0]);
          }
        });
        return mixer;
      },
    });
    await context.resume();
    playback.play(plan, 0.25, playback.now());
    await new Promise((resolve) => setTimeout(resolve, 2500));
    playback.dispose();
    let compared = 0;
    let differ = 0;
    let silent = 0;
    const left = exported.getChannelData(0);
    const right = exported.getChannelData(1);
    for (const [sample, [l, r]] of heard) {
      if (sample >= SECONDS * 48_000) continue;
      // Before the samples came in, the preview was silent: that is the late part, said so.
      if (l === 0 && r === 0) {
        silent += 1;
        continue;
      }
      compared += 1;
      if (l !== left[sample] || r !== right[sample]) differ += 1;
    }
    return { compared, differ, silent, state: context.state, notes };
  });
  console.log("preview against export:", JSON.stringify(result));
  expect(result.compared).toBeGreaterThan(48_000);
  expect(result.differ).toBe(0);
  // Only the start can be late, while the first samples are on their way.
  expect(result.silent).toBeLessThan(0.3 * 48_000);
});

test("the preview has sound at other speeds, backwards, on a device at another rate, and takes a new volume at once", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await open(page);
  await page.mouse.click(10, 10);
  const result = await page.evaluate(async () => {
    const lab = window as unknown as Lab;
    const audio = await lab.aqAudio();
    const url = await lab.aqMixerModule();
    const SECONDS = 6;
    const frames = SECONDS * 48_000;
    const samples = new Float32Array(frames * 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = 0.3 * Math.sin((index % frames) * 0.03);
    }
    const file = await audio.wavOf(new Blob([samples]), 2, frames, 48_000);
    const sound = { id: "a", file: "a", track: "t", start: 0, end: SECONDS, offset: 0, gain: 1 };
    const plan = { sounds: [sound], tracks: [{ id: "t", gain: 1, muted: false, solo: false }] };
    const exported = (
      await new audio.SoundMixer(plan, { fileOf: async () => file }).mix(0, frames)
    ).getChannelData(0);
    /** Plays for a while, and says how what the mixer gave compares with the export. */
    const play = async (options: {
      readonly rate: number;
      readonly from: number;
      readonly contextRate?: number;
      readonly gainAfter?: number;
    }) => {
      const heard: { sample: number; rate: number; left: Float32Array }[] = [];
      const context = new AudioContext({ sampleRate: options.contextRate ?? 48_000 });
      const playback = new audio.PlaybackAudio({
        fileOf: async () => file,
        onProblem: () => {},
        createContext: () => context,
        mixer: async (each) => {
          const mixer = await audio.createMixer(each, url);
          mixer.send({ kind: "capture", on: true });
          mixer.listen((report) => {
            if (report.kind === "captured") heard.push(report);
          });
          return mixer;
        },
      });
      await context.resume();
      playback.play(plan, options.from, playback.now(), options.rate);
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (options.gainAfter !== undefined) {
        playback.change({ ...plan, sounds: [{ ...sound, gain: options.gainAfter }] });
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      playback.dispose();
      let loud = 0;
      let exact = 0;
      let off = 0;
      /** Whether the new volume was heard yet: from one quantum on, and then in every one. */
      let changed = false;
      let back = 0;
      for (const { sample, rate, left } of heard) {
        let louder = 0;
        let before = 0;
        for (let index = 0; index < left.length; index += 1) {
          const value = left[index] ?? 0;
          loud = Math.max(loud, Math.abs(value));
          const at = sample + index * rate;
          // Where the timeline is at a whole sample, the mixer gives that sample as it is.
          if (Math.abs(at - Math.round(at)) > 1e-9 || value === 0) continue;
          const wanted = exported[Math.round(at)] ?? 0;
          if (Math.abs(value - wanted) < 1e-6) before += 1;
          else if (
            options.gainAfter !== undefined &&
            Math.abs(value - Math.fround(wanted * options.gainAfter)) < 1e-6
          ) {
            louder += 1;
          } else off += 1;
        }
        exact += before + louder;
        if (louder > 0 && before > 0) off += 1;
        if (louder > 0) changed = true;
        else if (changed && before > 0) back += 1;
      }
      if (options.gainAfter !== undefined && (!changed || back > 0)) off += 1;
      return { loud, exact, off, quanta: heard.length };
    };
    return {
      twice: await play({ rate: 2, from: 0.5 }),
      backwards: await play({ rate: -1, from: 5 }),
      slow: await play({ rate: 0.25, from: 1 }),
      device: await play({ rate: 1, from: 1, contextRate: 44_100 }),
      louder: await play({ rate: 1, from: 1, gainAfter: 0.5 }),
    };
  });
  console.log("the preview at other speeds:", JSON.stringify(result));
  for (const [name, { loud, quanta }] of Object.entries(result)) {
    expect(quanta, name).toBeGreaterThan(100);
    expect(loud, name).toBeGreaterThan(0.2);
  }
  for (const name of ["twice", "backwards", "slow", "louder"] as const) {
    expect(result[name].exact, name).toBeGreaterThan(10_000);
    expect(result[name].off, name).toBe(0);
  }
});

test("the browser mixes the fixed plans as Node does", async ({ page }) => {
  await open(page);
  const browser = await page.evaluate(async (cases) => {
    const lab = await (window as unknown as Lab).aqMixLab();
    return Promise.all(
      cases.map(async (each) => {
        const mix = lab.mixOfCase(each);
        return { hash: await lab.hashOfMix(mix), left: [...mix.left], right: [...mix.right] };
      }),
    );
  }, FIXED);
  for (const [index, each] of FIXED.entries()) {
    const node = mixOfCase(each);
    const there = browser[index];
    let largest = 0;
    for (const [channel, mine] of [node.left, node.right].entries()) {
      const theirs = channel === 0 ? there?.left : there?.right;
      for (const [sample, value] of mine.entries()) {
        largest = Math.max(largest, Math.abs(value - (theirs?.[sample] ?? Number.NaN)));
      }
    }
    console.log(
      `${each.name}: the browser's hash ${there?.hash === each.sha256 ? "is" : "is not"} the fixed one, largest difference to Node ${largest}`,
    );
    expect(Number.isNaN(largest), each.name).toBe(false);
    expect(largest, each.name).toBeLessThan(10 ** (-90 / 20));
  }
});
