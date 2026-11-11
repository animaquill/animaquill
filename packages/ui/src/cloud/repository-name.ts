import { nameProblem } from "./repository-text.ts";

/**
 * The name a new repository gets at first, from the name of the project, see the design of the
 * start page (docs/design/start-and-cloud.md of AnimaQuill Cloud), 3: letters and digits as they
 * are, Chinese as pinyin without tones, a dash between the syllables, and a dash for anything
 * else, so that GitHub takes it. Where nothing is left, `animaquill-` and the day. People can
 * change it.
 */

/** Pinyin for each character of a text of Chinese, without tones, ü as v. */
export type ToPinyin = (text: string) => readonly string[];

const HAN = /\p{Script=Han}/u;
const PLAIN = /[A-Za-z0-9]/;
/** GitHub takes up to 100 characters. */
const MOST = 100;

/**
 * Loads what turns Chinese into pinyin: pinyin-pro (MIT), with its dictionary. Only with
 * `import()`, as only a new project of the platform needs it, so that it is not in what the page
 * loads first. The same library can match pinyin for searching later.
 */
export async function loadPinyin(): Promise<ToPinyin> {
  const { pinyin } = await import("pinyin-pro");
  return (text) => pinyin(text, { toneType: "none", type: "array", v: true });
}

const dayOf = (now: number): string => {
  const day = new Date(now);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${day.getFullYear()}${two(day.getMonth() + 1)}${two(day.getDate())}`;
};

/**
 * The name for a new repository of a project called `name`. Without `toPinyin` Chinese counts as
 * anything else, as before it is loaded. `now`: the day where nothing is left of the name.
 */
export function repositoryNameOf(
  name: string,
  toPinyin: ToPinyin | undefined,
  now: number,
): string {
  const words: string[] = [];
  let plain = "";
  let han = "";
  const flushPlain = () => {
    if (plain) words.push(plain.toLowerCase());
    plain = "";
  };
  const flushHan = () => {
    if (han && toPinyin) {
      for (const syllable of toPinyin(han)) {
        const word = syllable.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
        if (word) words.push(word);
      }
    }
    han = "";
  };
  for (const character of name) {
    if (PLAIN.test(character)) {
      flushHan();
      plain += character;
    } else if (HAN.test(character)) {
      flushPlain();
      han += character;
    } else {
      flushPlain();
      flushHan();
    }
  }
  flushPlain();
  flushHan();
  let joined = "";
  for (const word of words) {
    const next = joined ? `${joined}-${word}` : word;
    // Only whole words: a name cut in the middle of a syllable reads wrong. A first word that is
    // too long by itself is cut all the same: it is still more of the name than a day is.
    if (next.length > MOST) {
      if (!joined) joined = word.slice(0, MOST);
      break;
    }
    joined = next;
  }
  if (joined === "" || nameProblem(joined) !== undefined) return `animaquill-${dayOf(now)}`;
  return joined;
}
