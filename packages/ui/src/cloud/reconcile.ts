/**
 * Putting two versions of one project together where nothing says what they had in common, see the
 * design of the start page of AnimaQuill Cloud, 4.2 ("对账"): what this computer has, as a folder
 * that was linked once before the data of the browser was cleared, and what the platform has. No
 * side is written over without people saying so: they choose, file by file, which side each file
 * of the project is to be, and nothing else of either side changes. What changes on the side of
 * the platform is one batch of files, as for files that changed in the folder, see
 * `ProjectStore.mergeFiles`, so that it syncs, and can be taken back as a whole.
 *
 * Nothing here reads or writes anything, or asks people: what to compare comes in, and what each
 * side is to be goes out. Whoever has the files writes them, see `FolderAdopt`. A copy of a project
 * that comes back to a working copy rebuilt from its repository goes through the same choices for
 * what a merge from their common base cannot settle.
 */
import {
  ProjectStore,
  folderBatch,
  type CommandFailure,
  type FileChange,
  type Origin,
} from "@animaquill/core";
import type { Problem } from "@animaquill/schema";
import type { TFunction } from "i18next";
import type { ReconcileItem } from "../workbench/dialogs.ts";

/** Which side a file of the project is to be: what this computer has, or what the platform has. */
export type ReconcileSide = "here" | "cloud";

/** A file of the project that the two sides have differently. */
export interface ReconcileDifference {
  /** From the top of the project. */
  readonly path: string;
  /** Both sides have it, each its own way; or only this computer has it; or only the platform. */
  readonly kind: "both" | "here" | "cloud";
  /**
   * Which side looks newer, by when the file here last changed and when the project of the
   * platform last did: only a hint, as the time of the platform is that of the whole project.
   * Undefined where nothing says.
   */
  readonly newer: ReconcileSide | undefined;
  /** When the file here last changed, in milliseconds since 1970. */
  readonly changedAt: number | undefined;
  /**
   * The file here cannot be read as part of the project: it can only go, or be what the platform
   * has. What it holds is kept first all the same.
   */
  readonly unreadable?: true;
}

/** What people chose, by path. A file without a choice keeps both sides from changing. */
export type ReconcileChoices = ReadonlyMap<string, ReconcileSide>;

/** What both sides are to be, once the choices are made, see `settle`. */
export interface Settled {
  /** Every file of the project as it is to be on both sides, by path. */
  readonly after: ReadonlyMap<string, string>;
  /** What the project of the platform takes in, as one batch of files from here. */
  readonly changes: readonly FileChange[];
  /** The origin of that batch, see `folderBatch`, for taking it back as a whole. */
  readonly origin: Origin;
  /**
   * Files chosen as they are here that the project can only take in part, as a change to a label
   * that only people can make in the editor: the file here becomes what the project took. Kept
   * first like any file that is written over.
   */
  readonly partly: readonly string[];
}

/** Why choices cannot be carried out together, for people to choose again. */
export interface Unsettled {
  readonly problems: readonly Problem[];
  /** Why the platform's side would not take the batch at all, in words where people read it. */
  readonly failure?: CommandFailure;
}

/** The newer side, by the time of a file here against that of the whole project of the platform. */
function newerOf(changedAt: number | undefined, updatedAt: number | undefined) {
  if (changedAt === undefined || updatedAt === undefined) return undefined;
  return changedAt > updatedAt ? "here" : "cloud";
}

/**
 * The files the two sides have differently: `here` and `cloud` as the project reads on each, both
 * written the way the editor writes them, so that a file that only looks different is the same.
 * `lost` are files here that are part of the project and cannot be read. `changedAt` tells when a
 * file here last changed, and `updatedAt` when the project of the platform did.
 */
export function differencesOf(
  here: ReadonlyMap<string, string>,
  cloud: ReadonlyMap<string, string>,
  {
    lost = [],
    changedAt = () => undefined,
    updatedAt,
  }: {
    readonly lost?: readonly string[];
    readonly changedAt?: (path: string) => number | undefined;
    readonly updatedAt?: number | undefined;
  } = {},
): ReconcileDifference[] {
  const unreadable = new Set(lost);
  const paths = new Set([...here.keys(), ...cloud.keys(), ...unreadable]);
  const differences: ReconcileDifference[] = [];
  for (const path of [...paths].toSorted()) {
    const mine = here.get(path);
    const theirs = cloud.get(path);
    const isLost = unreadable.has(path);
    if (!isLost && mine === theirs) continue;
    const time = changedAt(path);
    const kind = isLost
      ? theirs === undefined
        ? "here"
        : "both"
      : mine === undefined
        ? "cloud"
        : theirs === undefined
          ? "here"
          : "both";
    differences.push({
      path,
      kind,
      newer: isLost ? "cloud" : newerOf(time, updatedAt),
      changedAt: time,
      ...(isLost && { unreadable: true as const }),
    });
  }
  return differences;
}

/** The sides that people can choose for a file: one that cannot be read here is no choice. */
export const sidesOf = (difference: ReconcileDifference): readonly ReconcileSide[] =>
  difference.unreadable ? ["cloud"] : ["here", "cloud"];

/**
 * Which side loses what it has of a file where people choose `side` for it: the platform where the
 * file here takes the place of its own or it goes there, this computer the other way round.
 * Undefined where nothing goes, as a file that only comes in.
 */
export function replacedBy(
  difference: ReconcileDifference,
  side: ReconcileSide,
): ReconcileSide | undefined {
  if (side === "here") return difference.kind === "here" ? undefined : "cloud";
  return difference.kind === "cloud" ? undefined : "here";
}

/** How many files each side loses with these choices, see `replacedBy`. */
export function replacedCounts(
  differences: readonly ReconcileDifference[],
  choices: ReconcileChoices,
): { readonly cloud: number; readonly here: number } {
  let cloud = 0;
  let here = 0;
  for (const difference of differences) {
    const side = choices.get(difference.path);
    const loses = side && replacedBy(difference, side);
    if (loses === "cloud") cloud += 1;
    if (loses === "here") here += 1;
  }
  return { cloud, here };
}

/**
 * What a file is chosen to be until people say otherwise: the newer side where both have it, and
 * where only one side has it, that side, as nothing goes without people saying so.
 */
export function defaultSide(difference: ReconcileDifference): ReconcileSide {
  if (difference.unreadable) return "cloud";
  if (difference.kind === "here") return "here";
  if (difference.kind === "cloud") return "cloud";
  return difference.newer ?? "cloud";
}

/** The choices that people see first, see `defaultSide`. */
export const defaultChoices = (
  differences: readonly ReconcileDifference[],
): Map<string, ReconcileSide> =>
  new Map(differences.map((difference) => [difference.path, defaultSide(difference)]));

/** All of them one way, as far as each can be. */
export const allOneSide = (
  differences: readonly ReconcileDifference[],
  side: ReconcileSide,
): Map<string, ReconcileSide> =>
  new Map(
    differences.map((difference) => [
      difference.path,
      sidesOf(difference).includes(side) ? side : defaultSide(difference),
    ]),
  );

const problem = (file: string, message: string): Problem => ({
  severity: "error",
  code: "reconcile",
  file,
  message,
});

/**
 * What both sides are to be with these choices: each file as the side people chose for it, and every
 * other file as both have it. The project of the platform, `store`, takes in what it does not have
 * as one batch, and that is tried on a copy of it, which is how choices that do not go together
 * show: a timeline from here that uses an asset that only the platform has, which the platform's
 * list of assets would not have. Only files that people chose for can change, on either side: what
 * else would change refuses it. Nothing of `store` changes.
 */
export function settle(
  store: ProjectStore,
  here: ReadonlyMap<string, string>,
  cloud: ReadonlyMap<string, string>,
  differences: readonly ReconcileDifference[],
  choices: ReconcileChoices,
  batch: string,
  /**
   * Who the batch is from: files from the folder by default, which change no label that only
   * people can; the person, for what this computer had of the project already, see `take-back.ts`.
   */
  from: Origin = folderBatch(batch),
): Settled | Unsettled {
  const final = new Map(cloud);
  const asked = new Set<string>();
  for (const difference of differences) {
    const { path } = difference;
    const side = choices.get(path);
    if (side === undefined || !sidesOf(difference).includes(side)) {
      return { problems: [problem(path, "这个文件还没有选用哪一边")] };
    }
    asked.add(path);
    const text = side === "here" ? here.get(path) : cloud.get(path);
    if (text === undefined) final.delete(path);
    else final.set(path, text);
  }
  const changes: FileChange[] = [];
  for (const path of new Set([...cloud.keys(), ...final.keys()])) {
    const base = cloud.get(path);
    const text = final.get(path);
    if (base !== text) changes.push({ path, base, text });
  }
  const origin = from;
  const fork = ProjectStore.fromUpdates([store.encodeState()]).store;
  if (!fork) return { problems: [problem("", "云端的项目读不出来")] };
  try {
    if (changes.length > 0) {
      const merged = fork.mergeFiles(changes, { origin, baseOf: (path) => final.get(path) });
      if (!merged.ok) {
        return { problems: merged.error.problems ?? [], failure: merged.error };
      }
      const blocked = merged.files.filter(({ status }) => status !== "merged");
      if (blocked.length > 0) {
        const told = merged.problems.filter(({ severity }) => severity === "error");
        return {
          problems:
            told.length > 0
              ? told
              : blocked.map(({ path }) => problem(path, "这个文件和别的选择放在一起用不了")),
        };
      }
    }
    const { files: after, problems } = fork.exportFiles();
    const errors = problems.filter(({ severity }) => severity === "error");
    if (errors.length > 0) return { problems: errors };
    const partly: string[] = [];
    for (const path of new Set([...after.keys(), ...final.keys(), ...cloud.keys()])) {
      const now = after.get(path);
      if (now === final.get(path)) continue;
      // What nobody chose stays on both sides: a choice that changes another file is refused.
      if (!asked.has(path)) {
        return { problems: [problem(path, "这样选会连带改动别的文件，请换一种选法")] };
      }
      if (choices.get(path) === "here") partly.push(path);
      else return { problems: [problem(path, "云端的这个文件没法原样留下")] };
    }
    return { after, changes, origin, partly };
  } finally {
    fork.destroy();
  }
}

/** Whether `settle` came to something that can be carried out. */
export const isSettled = (outcome: Settled | Unsettled): outcome is Settled => "after" in outcome;

/**
 * Where the texts of a dialog that chooses sides are, by what "here" is: see "folder.adopt", and
 * "cloud.takeBack" for a copy that comes back to a working copy rebuilt from its repository.
 */
export type ReconcileWords = "folder.adopt" | "cloud.takeBack";

/** When a file changed, the way people say it: the time of day for today, and the day otherwise. */
export function whenText(time: number, now: number, t: TFunction): string {
  const date = new Date(time);
  const today = new Date(now);
  const two = (value: number) => String(value).padStart(2, "0");
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}`;
  if (date.toDateString() === today.toDateString()) return t("reconcile.today", { time: clock });
  const day = { month: date.getMonth() + 1, day: date.getDate(), time: clock };
  return date.getFullYear() === today.getFullYear()
    ? t("reconcile.day", day)
    : t("reconcile.dayOfYear", { ...day, year: date.getFullYear() });
}

/**
 * The files to choose for, the way people see them: how each side has it, and the choices, with
 * what is chosen now. `words` is where the texts are, as "here" is a folder for one and something
 * else for another: see "folder.adopt" in the texts.
 */
export function reconcileItems(
  differences: readonly ReconcileDifference[],
  choices: ReconcileChoices,
  t: TFunction,
  { now, words }: { readonly now: number; readonly words: ReconcileWords },
): ReconcileItem[] {
  return differences.map((difference) => {
    const { path, kind, newer, changedAt, unreadable } = difference;
    const status = unreadable
      ? t(`${words}.unreadable`)
      : kind === "here"
        ? t(`${words}.onlyHere`)
        : kind === "cloud"
          ? t(`${words}.onlyCloud`)
          : newer === "here" && changedAt !== undefined
            ? t(`${words}.newerHere`, { time: whenText(changedAt, now, t) })
            : newer === "cloud"
              ? t(`${words}.newerCloud`)
              : t(`${words}.both`);
    const label = (side: ReconcileSide): string => {
      if (kind === "both") return t(side === "here" ? `${words}.useHere` : `${words}.useCloud`);
      // Only one side has it: that side keeps it, the other takes it away.
      const keeps = (kind === "here") === (side === "here");
      if (unreadable) return t(keeps ? `${words}.keep` : `${words}.moveAway`);
      return t(keeps ? `${words}.keep` : `${words}.drop`);
    };
    // The side that keeps a file first, as people read "留下" before "删掉".
    const sides = sidesOf(difference).toSorted((a, b) =>
      kind === "cloud" ? (a === "cloud" ? -1 : b === "cloud" ? 1 : 0) : 0,
    );
    return {
      path,
      status,
      options: sides.map((side) => ({ id: side, label: label(side) })),
      value: choices.get(path) ?? defaultSide(difference),
    };
  });
}
