/**
 * Words of one text against another, for people to see what differs: runs that both have, that only
 * the first has (taken out) and that only the second has (put in). Words and the blanks between them
 * are the pieces, so a run never splits a word.
 */

export type DiffRun = { readonly text: string; readonly kind: "same" | "out" | "in" };

/** Past this many cells of the table the middle that differs shows as taken out and put in whole. */
const MAX_CELLS = 400_000;

const piecesOf = (text: string): string[] => text.match(/\s+|[^\s]+/gu) ?? [];

function push(runs: DiffRun[], kind: DiffRun["kind"], text: string): void {
  if (text === "") return;
  const last = runs.at(-1);
  if (last?.kind === kind) runs[runs.length - 1] = { kind, text: last.text + text };
  else runs.push({ kind, text });
}

export function wordDiff(before: string, after: string): readonly DiffRun[] {
  const a = piecesOf(before);
  const b = piecesOf(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const runs: DiffRun[] = [];
  push(runs, "same", a.slice(0, start).join(""));
  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const rows = middleA.length;
  const columns = middleB.length;
  if ((rows + 1) * (columns + 1) > MAX_CELLS) {
    push(runs, "out", middleA.join(""));
    push(runs, "in", middleB.join(""));
  } else {
    // The longest run of pieces both have, from the end, so that the walk below goes forwards.
    const width = columns + 1;
    const table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
      for (let j = columns - 1; j >= 0; j--) {
        table[i * width + j] =
          middleA[i] === middleB[j]
            ? (table[(i + 1) * width + j + 1] as number) + 1
            : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < columns) {
      if (middleA[i] === middleB[j]) {
        push(runs, "same", middleA[i] as string);
        i++;
        j++;
      } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
        push(runs, "out", middleA[i] as string);
        i++;
      } else {
        push(runs, "in", middleB[j] as string);
        j++;
      }
    }
    push(runs, "out", middleA.slice(i).join(""));
    push(runs, "in", middleB.slice(j).join(""));
  }
  push(runs, "same", a.slice(endA).join(""));
  return runs;
}
