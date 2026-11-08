/**
 * Merging text by lines, the way diff3 does: what one side changed comes in where the other side left
 * the text as it was. Where both sides changed the same lines differently, one of them has to win.
 * That is the side given as `ours`, and the merge says where, so that people can look.
 */

/** Where in a text, by lines from 0, the last one not included. */
export interface LineRange {
  readonly from: number;
  readonly to: number;
}

/** Lines that both sides changed, each in its own way. */
export interface TextConflict {
  /** The lines of `ours` in the merged text. */
  readonly at: LineRange;
  readonly base: LineRange;
  readonly ours: LineRange;
  readonly theirs: LineRange;
}

export interface MergedText {
  readonly text: string;
  readonly conflicts: readonly TextConflict[];
}

/** Lines of a text, each with what ends it, so that joining them gives the text back. */
export function linesOf(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const end = text.indexOf("\n", start);
    if (end < 0) break;
    lines.push(text.slice(start, end + 1));
    start = end + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * Two texts further apart than about twice this many lines are a rewrite rather than an edit, and so
 * are texts that would take more than `MOST_WORK` to tell apart. Finding the fewest changes between
 * them would take too long, so the stretch counts as replaced as a whole: a merge then keeps the
 * editor's side of it and says so, which loses nothing of the editor's. A formatter that went over a
 * whole file still leaves most lines as they were, and stays well within this.
 */
const MOST_EDITS = 20_000;

/**
 * How many steps telling two texts apart may take: some hundreds of milliseconds. Steps rather than
 * time, so that the same texts always come out the same, on any machine.
 */
const MOST_WORK = 20_000_000;

/** What is left of `MOST_WORK` for one look at two texts. */
interface Work {
  left: number;
}

/**
 * Where the fewest changes from `a` to `b` go through the middle, as a point to cut both at, the way
 * Myers finds it from both ends at once. Undefined when they are too far apart, see `MOST_EDITS`.
 */
function bisect(
  a: readonly number[],
  aLo: number,
  aHi: number,
  b: readonly number[],
  bLo: number,
  bHi: number,
  work: Work,
): readonly [number, number] | undefined {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const most = Math.min(Math.ceil((n + m) / 2), MOST_EDITS);
  const offset = most + 1;
  const size = 2 * offset + 1;
  const forward = new Int32Array(size).fill(-1);
  const backward = new Int32Array(size).fill(-1);
  forward[offset + 1] = 0;
  backward[offset + 1] = 0;
  const delta = n - m;
  // Which of the two ways meets the other first depends on whether their difference in length is odd.
  const isOdd = (delta & 1) !== 0;
  let forwardStart = 0;
  let forwardEnd = 0;
  let backwardStart = 0;
  let backwardEnd = 0;
  const at = (vector: Int32Array, index: number) => vector[index] ?? -1;
  for (let d = 0; d < most; d++) {
    work.left -= 4 * d + 2;
    if (work.left < 0) return undefined;
    for (let k = -d + forwardStart; k <= d - forwardEnd; k += 2) {
      const index = offset + k;
      let x =
        k === -d || (k !== d && at(forward, index - 1) < at(forward, index + 1))
          ? at(forward, index + 1)
          : at(forward, index - 1) + 1;
      let y = x - k;
      const from = x;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      work.left -= x - from;
      forward[index] = x;
      if (x > n) forwardEnd += 2;
      else if (y > m) forwardStart += 2;
      else if (isOdd) {
        const other = offset + delta - k;
        if (
          other >= 0 &&
          other < size &&
          at(backward, other) !== -1 &&
          x >= n - at(backward, other)
        ) {
          return [aLo + x, bLo + y];
        }
      }
    }
    for (let k = -d + backwardStart; k <= d - backwardEnd; k += 2) {
      const index = offset + k;
      let x =
        k === -d || (k !== d && at(backward, index - 1) < at(backward, index + 1))
          ? at(backward, index + 1)
          : at(backward, index - 1) + 1;
      let y = x - k;
      const from = x;
      while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
        x++;
        y++;
      }
      work.left -= x - from;
      backward[index] = x;
      if (x > n) backwardEnd += 2;
      else if (y > m) backwardStart += 2;
      else if (!isOdd) {
        const other = offset + delta - k;
        const reached = at(forward, other);
        if (other >= 0 && other < size && reached !== -1 && reached >= n - x) {
          return [aLo + reached, bLo + reached - (other - offset)];
        }
      }
    }
  }
  return undefined;
}

function matchRange(
  a: readonly number[],
  aLo: number,
  aHi: number,
  b: readonly number[],
  bLo: number,
  bHi: number,
  match: Int32Array,
  work: Work,
): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) match[aLo++] = bLo++;
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) match[--aHi] = --bHi;
  // Only lines that come or go are left, or nothing.
  if (aLo === aHi || bLo === bHi) return;
  const cut = bisect(a, aLo, aHi, b, bLo, bHi, work);
  if (!cut) return;
  const [x, y] = cut;
  // A cut at either end would take this apart into itself again.
  if ((x === aLo && y === bLo) || (x === aHi && y === bHi)) return;
  matchRange(a, aLo, x, b, bLo, y, match, work);
  matchRange(a, x, aHi, b, y, bHi, match, work);
}

/**
 * Which line of `b` each line of `a` stays as, or -1 for one that does not: a longest common
 * subsequence, by the fewest changes.
 *
 * A line that only one of the two has can never stay, so those are left out before looking, as GNU
 * diff does: what a formatter changed all over a file is mostly such lines, and what is left then is
 * close to the same on both sides, which is quick to go through.
 */
export function matchLines(a: readonly number[], b: readonly number[]): Int32Array {
  const match = new Int32Array(a.length).fill(-1);
  const inA = new Set(a);
  const inB = new Set(b);
  const keptA = a.flatMap((line, index) => (inB.has(line) ? [index] : []));
  const keptB = b.flatMap((line, index) => (inA.has(line) ? [index] : []));
  const shorter = new Int32Array(keptA.length).fill(-1);
  matchRange(
    keptA.map((index) => a[index] as number),
    0,
    keptA.length,
    keptB.map((index) => b[index] as number),
    0,
    keptB.length,
    shorter,
    { left: MOST_WORK },
  );
  shorter.forEach((at, index) => {
    if (at >= 0) match[keptA[index] as number] = keptB[at] as number;
  });
  return match;
}

const sameLines = (
  a: readonly number[],
  aFrom: number,
  aTo: number,
  b: readonly number[],
  bFrom: number,
  bTo: number,
) => {
  if (aTo - aFrom !== bTo - bFrom) return false;
  for (let index = 0; index < aTo - aFrom; index++) {
    if (a[aFrom + index] !== b[bFrom + index]) return false;
  }
  return true;
};

/**
 * Brings what `theirs` changed from `base` into `ours`. Lines all three have in common hold the rest
 * in place. A stretch between them that only one side changed takes that side, and one that both
 * changed the same way takes that. One that both changed differently stays as `ours` has it: that is
 * a conflict, and the result says where it is.
 */
export function mergeText(base: string, ours: string, theirs: string): MergedText {
  if (ours === base || ours === theirs) return { text: theirs, conflicts: [] };
  if (theirs === base) return { text: ours, conflicts: [] };
  const lines = { base: linesOf(base), ours: linesOf(ours), theirs: linesOf(theirs) };
  const ids = new Map<string, number>();
  const idsOf = (each: readonly string[]) =>
    each.map((line) => {
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      return id;
    });
  const o = idsOf(lines.base);
  const a = idsOf(lines.ours);
  const b = idsOf(lines.theirs);
  const toOurs = matchLines(o, a);
  const toTheirs = matchLines(o, b);

  const merged: string[] = [];
  const conflicts: TextConflict[] = [];
  const take = (from: readonly string[], start: number, end: number) => {
    for (let index = start; index < end; index++) merged.push(from[index] as string);
  };
  let io = 0;
  let ia = 0;
  let ib = 0;
  for (;;) {
    // Lines that stay in all three.
    let same = 0;
    while (
      io + same < o.length &&
      toOurs[io + same] === ia + same &&
      toTheirs[io + same] === ib + same
    ) {
      same++;
    }
    if (same > 0) {
      take(lines.base, io, io + same);
      io += same;
      ia += same;
      ib += same;
      continue;
    }
    if (io === o.length && ia === a.length && ib === b.length) break;
    // What changed, up to the next line of the base that both sides kept.
    let next = io;
    while (next < o.length && ((toOurs[next] ?? -1) < 0 || (toTheirs[next] ?? -1) < 0)) next++;
    const ja = next < o.length ? (toOurs[next] as number) : a.length;
    const jb = next < o.length ? (toTheirs[next] as number) : b.length;
    if (sameLines(a, ia, ja, o, io, next)) {
      take(lines.theirs, ib, jb);
    } else if (sameLines(b, ib, jb, o, io, next) || sameLines(a, ia, ja, b, ib, jb)) {
      take(lines.ours, ia, ja);
    } else {
      const from = merged.length;
      take(lines.ours, ia, ja);
      conflicts.push({
        at: { from, to: merged.length },
        base: { from: io, to: next },
        ours: { from: ia, to: ja },
        theirs: { from: ib, to: jb },
      });
    }
    io = next;
    ia = ja;
    ib = jb;
  }
  return { text: merged.join(""), conflicts };
}
