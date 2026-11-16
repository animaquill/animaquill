/**
 * Two versions of a text line by line, as a diff shows them: what stayed, what went and what came,
 * with the number each line has on its side. For the card of what AI changed, which shows a few
 * lines around each change; the code editor compares whole files side by side (`DiffView`).
 */

export interface DiffLine {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
  /** Its number before, from 1, where it was there before. */
  readonly before?: number;
  /** Its number after, where it is there after. */
  readonly after?: number;
}

/** Lines that follow one another, with what is around them. */
export type DiffHunk = readonly DiffLine[];

/** How many changes the comparison looks for before it calls the rest one change. */
const MOST_EDITS = 2000;

/** The lines of a text. One that ends a line has no empty line after it. */
export function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type Edit = "same" | "removed" | "added";

/**
 * The shortest way from `a` to `b` as edits (Myers): undefined where it takes more than `most`.
 * Each round keeps only the part of the frontier it reached, so that memory grows with the number
 * of edits squared, and not with the lines.
 */
function shortest(a: readonly string[], b: readonly string[], most: number): Edit[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, most); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
          ? (v[offset + k + 1] as number)
          : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) found = d;
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (found >= 0) break;
  }
  if (found < 0) return undefined;
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const before = trace[d - 1] as Int32Array;
    const at = (k: number) => before[k + d - 1] as number;
    const k = x - y;
    const from = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const fromX = at(from);
    const fromY = fromX - from;
    while (x > fromX && y > fromY) {
      edits.push("same");
      x -= 1;
      y -= 1;
    }
    edits.push(x === fromX ? "added" : "removed");
    x = fromX;
    y = fromY;
  }
  for (; x > 0; x--) edits.push("same");
  return edits.toReversed();
}

/**
 * Two texts line by line. The lines that are the same at both ends stay out of the search, which
 * makes a small change in a long file quick; where the rest takes too many changes to find their
 * shortest way, all of it went and came.
 */
export function diffLines(before: string, after: string, most = MOST_EDITS): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end += 1;
  }
  const middleA = a.slice(start, a.length - end);
  const middleB = b.slice(start, b.length - end);
  const edits = shortest(middleA, middleB, most) ?? [
    ...middleA.map((): Edit => "removed"),
    ...middleB.map((): Edit => "added"),
  ];
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  const same = () => {
    lines.push({ kind: "same", text: a[i] as string, before: i + 1, after: j + 1 });
    i += 1;
    j += 1;
  };
  for (let count = 0; count < start; count++) same();
  for (const edit of edits) {
    if (edit === "same") same();
    else if (edit === "removed") {
      lines.push({ kind: "removed", text: a[i] as string, before: i + 1 });
      i += 1;
    } else {
      lines.push({ kind: "added", text: b[j] as string, after: j + 1 });
      j += 1;
    }
  }
  for (let count = a.length - i; count > 0; count--) same();
  return lines;
}

/** The changed lines with `context` lines around each, in pieces where nothing is between them. */
export function hunksOf(lines: readonly DiffLine[], context = 2): DiffHunk[] {
  const shown = new Uint8Array(lines.length);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    for (let at = from; at <= to; at++) shown[at] = 1;
  });
  const hunks: DiffLine[][] = [];
  let current: DiffLine[] | undefined;
  lines.forEach((line, index) => {
    if (!shown[index]) {
      current = undefined;
      return;
    }
    if (!current) {
      current = [];
      hunks.push(current);
    }
    current.push(line);
  });
  return hunks;
}
