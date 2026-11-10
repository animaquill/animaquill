import { expect, needsDevPage, test } from "./support.ts";

test.use({ withProject: false });

test("mixing a long MP3 piece by piece only looks for the place once", async ({
  page,
  devPage,
}) => {
  test.skip(!devPage, needsDevPage("window.aqAudio"));
  test.setTimeout(240_000);
  const pieces = await page.evaluate(async () => {
    // An hour of silent MPEG-1 Layer III frames, 128 kbit/s, 44.1 kHz, stereo, without a Xing frame.
    const FRAME = 417;
    const frames = Math.ceil((3600 * 44_100) / 1152);
    const bytes = new Uint8Array(FRAME * frames);
    for (let index = 0; index < frames; index += 1) {
      bytes.set([0xff, 0xfb, 0x90, 0x00], index * FRAME);
    }
    /**
     * The file, counting what gets read of it. Without an index, finding a place in an MP3 means
     * reading it from its start up to there, so how much is read says whether it looked again. Time
     * would say so too, but a busy machine takes as long for ten seconds of sound now and then.
     */
    let read = 0;
    const counted = <T extends Blob>(part: T): T =>
      Object.assign(part, {
        stream: () =>
          Blob.prototype.stream.call(part).pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                read += chunk.byteLength;
                controller.enqueue(chunk);
              },
            }),
          ),
        arrayBuffer: async () => {
          const data = await Blob.prototype.arrayBuffer.call(part);
          read += data.byteLength;
          return data;
        },
      });
    class CountedFile extends Blob {
      override slice(start?: number, end?: number, type?: string): Blob {
        return counted(super.slice(start, end, type));
      }
    }
    const file = counted(new CountedFile([bytes], { type: "audio/mpeg" }));
    // The module as the development page has it, to mix without an editor around it.
    const { aqAudio } = window as unknown as {
      aqAudio: () => Promise<typeof import("../../audio/src/index.ts")>;
    };
    const audio = await aqAudio();
    const sound = { id: "music", file: "music", start: 0, end: 3600, offset: 0, gain: 1 };
    const mixer = new audio.SoundMixer({ sounds: [sound] }, { fileOf: async () => file });
    const out: { at: number; read: number; ms: number }[] = [];
    // One piece after the other, as an export mixes them: only the first finds its place.
    for (const at of [3560, 3570, 3580, 3590]) {
      const before = read;
      const started = performance.now();
      await mixer.mix(at, 480_000);
      out.push({ at, read: read - before, ms: Math.round(performance.now() - started) });
    }
    return { size: bytes.length, out };
  });
  console.log("ten seconds of the mix, by where it starts:", JSON.stringify(pieces));
  const [first, ...later] = pieces.out;
  // Finding the place read the file up to there, nearly all of it.
  expect(first?.read).toBeGreaterThan(pieces.size / 2);
  // Each piece after it reads only its own ten seconds, and what comes right after them.
  for (const { read } of later) expect(read).toBeLessThan(pieces.size / 10);
});
