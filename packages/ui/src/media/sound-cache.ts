import { isMadeFile, type MediaStore } from "@animaquill/host";

export interface SoundCacheRules {
  /** What nobody needs goes after this long without being used. */
  readonly maxAgeMs: number;
  /** Above this, what nobody needs goes even when it is newer, the least recently used first. */
  readonly maxBytes: number;
}

export const SOUND_CACHE_RULES: SoundCacheRules = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxBytes: 500 * 1024 ** 2,
};

/** The name of a sound that a waveform belongs to, or the name itself for a sound. */
const soundOf = (name: string) => name.replace(/^peaks-\d+:/, "");

/**
 * Takes away sounds that code made for a project and that nothing in it needs any more: every change
 * to the code makes a new one. `needed` says what has to stay: the sounds the project plays now, and
 * whatever an asset is called, which no made file should ever be but would stay if it were. Only
 * made files can go at all, see `isMadeFile`, and a file that cannot be removed stays for next time.
 * Gives the names of what went.
 */
export async function cleanSoundCache(
  media: MediaStore,
  needed: (name: string) => boolean,
  now: number,
  rules: SoundCacheRules = SOUND_CACHE_RULES,
): Promise<readonly string[]> {
  const made = (await media.listMade()).filter(({ name }) => isMadeFile(name));
  let total = made.reduce((sum, { size }) => sum + size, 0);
  const spare = made
    .filter(({ name }) => !needed(name) && !needed(soundOf(name)))
    .toSorted((a, b) => a.usedAt - b.usedAt);
  const removed: string[] = [];
  for (const { name, size, usedAt } of spare) {
    if (now - usedAt <= rules.maxAgeMs && total <= rules.maxBytes) continue;
    try {
      await media.removeMade(name);
      total -= size;
      removed.push(name);
    } catch (error) {
      console.warn("A made file could not be removed", error);
    }
  }
  return removed;
}
