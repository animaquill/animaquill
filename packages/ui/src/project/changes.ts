import { projectFrameRate, timingProblems, type ProjectState } from "@animaquill/core";
import { parseTime, type ProjectManifest } from "@animaquill/schema";

type ProjectFormat = ProjectManifest["formats"][number];
import { formatTimecode, frameRate } from "../timeline/frames.ts";

/**
 * What the project properties tell people before a change that changes what they see
 * (docs/design/settings-and-properties.md of AnimaQuill Cloud, 5.3): worked out from the project,
 * no DOM, so that the numbers of the dialogs are tested here.
 */

/** Whether a text is a frame rate the format takes: a time above 0. */
export function isFrameRate(text: string): boolean {
  try {
    return parseTime(text.trim()).n > 0n;
  } catch {
    return false;
  }
}

/** The reduced aspect ratio of a size, such as 16:9. */
export function ratioOf(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const common = gcd(width, height) || 1;
  return `${width / common}:${height / common}`;
}

export const sameRatio = (a: ProjectFormat, b: ProjectFormat): boolean =>
  a.width * b.height === b.width * a.height;

/** How the master changes: not at all as the picture goes, only in size, or in its shape. */
export type MasterChange = "none" | "size" | "ratio";

export function masterChange(
  before: readonly ProjectFormat[],
  after: readonly ProjectFormat[],
): MasterChange {
  const [was] = before;
  const [now] = after;
  if (!was || !now) return "none";
  if (was.width === now.width && was.height === now.height) return "none";
  return sameRatio(was, now) ? "size" : "ratio";
}

/** What changing the editing frame rate comes to, as the dialog before it says (5.3). */
export interface FrameRateChange {
  readonly from: string;
  readonly to: string;
  /** A moment, as the timecode shows it now and once the rate is the new one. */
  readonly example: { readonly before: string; readonly after: string };
  /** How many times of the project are between frames of the new rate, see `timingProblems`. */
  readonly offGrid: number;
  /** The master format, whose export frame rate may go along. */
  readonly master: { readonly name: string; readonly fps: string };
  /** Whether the master is exported at the rate of editing now: then it goes along by default. */
  readonly masterAlong: boolean;
}

/** Where the example of a timecode is: the playhead, or 12.5 s where it is at the start. */
const EXAMPLE_SECONDS = 12.5;

export function frameRateChange(state: ProjectState, to: string, seconds: number): FrameRateChange {
  const from = projectFrameRate(state.manifest);
  const at = seconds > 0 ? seconds : EXAMPLE_SECONDS;
  // The frame the moment is in, as the timecode of a moment says it.
  const timecode = (rate: string) => {
    const exact = frameRate(rate);
    return formatTimecode(Math.floor(at * exact.fps + 1e-6), exact);
  };
  const changed = { ...state, manifest: { ...state.manifest, fps: to } };
  const offGrid = timingProblems(changed).reduce(
    (sum, problem) => sum + Number(problem.params.count ?? 0),
    0,
  );
  const master = state.manifest.formats[0];
  return {
    from,
    to,
    example: { before: timecode(from), after: timecode(to) },
    offGrid,
    master: { name: master?.name ?? "", fps: master?.fps ?? from },
    masterAlong: master !== undefined && sameRate(master.fps, from),
  };
}

/** Whether two rates are the same, however they are written. */
export function sameRate(a: string, b: string): boolean {
  try {
    const x = parseTime(a);
    const y = parseTime(b);
    return x.n === y.n && x.d === y.d;
  } catch {
    return a === b;
  }
}

/** The frame rates people pick from, the way the format writes them, with how they are said. */
export const FRAME_RATES: readonly { readonly value: string; readonly label: string }[] = [
  { value: "24000/1001", label: "23.976" },
  { value: "24", label: "24" },
  { value: "25", label: "25" },
  { value: "30000/1001", label: "29.97" },
  { value: "30", label: "30" },
  { value: "50", label: "50" },
  { value: "60000/1001", label: "59.94" },
  { value: "60", label: "60" },
];

/** A rate as people read it: 29.97 for 30000/1001. */
export function rateLabel(rate: string): string {
  const known = FRAME_RATES.find((each) => sameRate(each.value, rate));
  if (known) return known.label;
  try {
    const { n, d } = parseTime(rate);
    const value = Number(n) / Number(d);
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "");
  } catch {
    return rate;
  }
}

/** Safe areas people pick for the master, as fractions of each side (5.2). */
export const SAFE_AREAS = {
  /** Action safe: 90 % of the picture. */
  action: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
  /** Title safe: 80 % of the picture. */
  title: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 },
} as const;

export type SafeAreaChoice = "none" | "action" | "title" | "custom";

export function safeAreaChoice(format: ProjectFormat | undefined): SafeAreaChoice {
  const area = format?.safeArea;
  if (!area) return "none";
  for (const choice of ["action", "title"] as const) {
    const known = SAFE_AREAS[choice];
    if (
      known.top === area.top &&
      known.right === area.right &&
      known.bottom === area.bottom &&
      known.left === area.left
    )
      return choice;
  }
  return "custom";
}

/** Presets for a new format (R2): landscape, vertical and square at 1080, at the rate of editing. */
export function formatPresets(fps: string): readonly Omit<ProjectFormat, "id" | "name">[] {
  return [
    { width: 1920, height: 1080, fps },
    { width: 1080, height: 1920, fps },
    { width: 1080, height: 1080, fps },
  ];
}

/** An id for a new format or language that none of `taken` has. */
export function freeId(base: string, taken: readonly string[]): string {
  const clean = base.replaceAll(/[^A-Za-z0-9_-]/g, "") || "format";
  if (!taken.includes(clean)) return clean;
  for (let number = 2; ; number += 1) {
    const id = `${clean}-${number}`;
    if (!taken.includes(id)) return id;
  }
}
