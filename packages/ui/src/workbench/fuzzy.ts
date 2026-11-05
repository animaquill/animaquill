export interface FuzzyMatch {
  readonly score: number;
  /** Which characters of the text matched, for highlighting. */
  readonly positions: readonly number[];
}

const NEXT_TO_PREVIOUS = 5;
const WORD_START = 3;
const LATER_IN_TEXT = 0.01;

const startsWord = (text: readonly string[], index: number) =>
  index === 0 || /[\s:：.\-_/（(]/.test(text[index - 1] ?? "");

/**
 * Finds the characters of the query in order in the text, and scores how good the fit is:
 * characters next to each other and at the start of a word count more. Spaces in the query are
 * ignored. Returns undefined when the text does not contain the query.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const needle = [...query.toLowerCase().replace(/\s+/g, "")];
  const hay = [...text.toLowerCase()];
  if (needle.length === 0) return { score: 0, positions: [] };

  // best[j] is the best score with the current query character at text position j.
  let best: (number | undefined)[] = [];
  const from: (number | undefined)[][] = [];

  needle.forEach((character, i) => {
    const row: (number | undefined)[] = [];
    const links: (number | undefined)[] = [];
    hay.forEach((candidate, j) => {
      if (candidate !== character) return;
      const own = 1 + (startsWord(hay, j) ? WORD_START : 0) - j * LATER_IN_TEXT;
      if (i === 0) {
        row[j] = own;
        return;
      }
      for (let k = 0; k < j; k++) {
        const previous = best[k];
        if (previous === undefined) continue;
        const score = previous + own + (k === j - 1 ? NEXT_TO_PREVIOUS : 0);
        if (row[j] === undefined || score > (row[j] as number)) {
          row[j] = score;
          links[j] = k;
        }
      }
    });
    best = row;
    from.push(links);
  });

  let end: number | undefined;
  best.forEach((score, j) => {
    if (score === undefined) return;
    if (end === undefined || score > (best[end] as number)) end = j;
  });
  if (end === undefined) return undefined;

  const positions = [end];
  for (let i = needle.length - 1; i > 0; i--) {
    const previous = from[i]?.[positions[0] as number];
    positions.unshift(previous as number);
  }
  return { score: best[end] as number, positions };
}
