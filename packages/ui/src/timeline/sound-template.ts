import { CURRENT_SCENE_RUNTIME, type SoundManifest } from "@animaquill/schema";

const CODE = `// A few bells going up, and a little sparkle that the seed decides.
aq.sound(({ frames, sampleRate }) => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const notes = [523.25, 659.25, 783.99, 1046.5];

  notes.forEach((frequency, index) => {
    const start = Math.floor((index * frames) / (notes.length * 2));
    const pan = index / (notes.length - 1);
    for (let at = start; at < frames; at += 1) {
      const time = (at - start) / sampleRate;
      const level = 0.25 * Math.exp(-time * 4) * Math.min(time * 500, 1);
      const tone = Math.sin(2 * Math.PI * frequency * time);
      const overtone = 0.3 * Math.sin(4 * Math.PI * frequency * time);
      left[at] += level * (tone + overtone) * (1 - pan * 0.6);
      right[at] += level * (tone + overtone) * (0.4 + pan * 0.6);
    }
  });

  for (let at = 0; at < frames; at += 1) {
    const fade = 1 - at / frames;
    const sparkle = (Math.random() * 2 - 1) * 0.015 * fade * fade;
    left[at] = (left[at] + sparkle) * Math.min(fade * 20, 1);
    right[at] = (right[at] + sparkle) * Math.min(fade * 20, 1);
  }

  return [left, right];
});
`;

export const SOUND_TEMPLATE_SECONDS = 1.5;

/** What a new sound starts out as: something to hear at once, and to change. */
export function soundTemplate(
  name: string,
  words: { readonly duration: string; readonly seed: string },
): {
  readonly manifest: SoundManifest;
  readonly files: Readonly<Record<string, string>>;
} {
  const sound: SoundManifest = {
    name,
    entry: "sound.js",
    runtime: CURRENT_SCENE_RUNTIME,
    params: [
      {
        id: "duration",
        name: words.duration,
        type: "number",
        default: SOUND_TEMPLATE_SECONDS,
        min: 0.05,
        max: 300,
      },
      { id: "seed", name: words.seed, type: "number", default: 1 },
    ],
  };
  return { manifest: sound, files: { "sound.js": CODE } };
}
