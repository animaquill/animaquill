import { expect, test } from "./support.ts";

test.use({ withProject: false });

test("mixing a long MP3 piece by piece only looks for the place once", async ({ page }) => {
  test.setTimeout(240_000);
  const timings = await page.evaluate(async () => {
    // An hour of silent MPEG-1 Layer III frames, 128 kbit/s, 44.1 kHz, stereo, without a Xing frame.
    const FRAME = 417;
    const frames = Math.ceil((3600 * 44_100) / 1152);
    const bytes = new Uint8Array(FRAME * frames);
    for (let index = 0; index < frames; index += 1) {
      bytes.set([0xff, 0xfb, 0x90, 0x00], index * FRAME);
    }
    const file = new Blob([bytes], { type: "audio/mpeg" });
    // The module as the development server has it, to mix without an editor around it.
    const path = "/@fs/work/oss/packages/audio/src/index.ts";
    const audio = (await import(
      /* @vite-ignore */ path
    )) as typeof import("../../audio/src/index.ts");
    const sound = { id: "music", file: "music", start: 0, end: 3600, offset: 0, gain: 1 };
    const mixer = new audio.SoundMixer({ sounds: [sound] }, { fileOf: async () => file });
    const out: { at: number; ms: number; longestTaskMs: number }[] = [];
    // One piece after the other, as an export mixes them: only the first finds its place.
    for (const at of [3560, 3570, 3580, 3590]) {
      let longest = 0;
      let last = performance.now();
      const watch = setInterval(() => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
      }, 0);
      const started = performance.now();
      await mixer.mix(at, 480_000);
      out.push({
        at,
        ms: Math.round(performance.now() - started),
        longestTaskMs: Math.round(longest),
      });
      clearInterval(watch);
    }
    return out;
  });
  console.log("ten seconds of the mix, by where it starts:", JSON.stringify(timings));
  const later = timings.slice(1);
  expect(Math.max(...later.map(({ ms }) => ms))).toBeLessThan((timings[0]?.ms ?? 0) / 2 + 100);
  // Looking for the place again would take about as long as the first time. Next to other browsers
  // a piece alone can take a little longer than 100 ms now and then.
  const first = timings[0]?.longestTaskMs ?? 0;
  expect(Math.max(...later.map(({ longestTaskMs }) => longestTaskMs))).toBeLessThan(
    Math.max(100, first / 4),
  );
});
