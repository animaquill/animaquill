/**
 * What a name that does not fit is most like: for "did you mean" in errors, and for the ids that
 * an id of nothing is closest to. Close means few edits apart, case and separators aside.
 */

/** Letters only, in one case: "clipId", "clip_id" and "ClipID" are the same name. */
const plain = (name: string) => name.toLowerCase().replaceAll(/[_\-.\s]/g, "");

/** How many letters to add, take away or swap to get from one to the other. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(
        Math.min((previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost),
      );
    }
    previous = row;
  }
  return previous[b.length] ?? 0;
}

/** How far apart two names are, as people mistype them: 0 when only case or separators differ. */
function distance(wrong: string, right: string): number {
  const a = plain(wrong);
  const b = plain(right);
  if (a === b) return 0;
  if (b.startsWith(a) || a.startsWith(b) || a.includes(b) || b.includes(a)) return 1;
  return editDistance(a, b);
}

/** The one name that a mistyped one surely means: off by case, separators or two letters at most. */
export function didYouMean(wrong: string, names: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const found = distance(wrong, name);
    if (found < bestDistance) {
      best = name;
      bestDistance = found;
    }
  }
  const limit = Math.min(2, Math.max(1, Math.floor(plain(wrong).length / 3)));
  return bestDistance <= limit ? best : undefined;
}

/** The names most like a wrong one, closest first: for ids and topics that are not there. */
export function mostLike(wrong: string, names: readonly string[], count = 3): readonly string[] {
  return names
    .map((name) => ({ name, distance: distance(wrong, name) }))
    .filter(({ name, distance: far }) => far <= Math.max(3, Math.floor(name.length / 2)))
    .toSorted((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, count)
    .map(({ name }) => name);
}
