/**
 * What `CloudProjects` needs around taking a copy back (`take-back.ts`) that is about people and the
 * folder: asking them which side files are to be, and keeping what the folder had of the files that
 * change before anything changes them.
 */
import { FolderError, type LocalFolder } from "@animaquill/host";
import type { Problem } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { commandFailedText } from "../i18n/failures.ts";
import type { Dialogs, FormAnswer } from "../workbench/dialogs.ts";
import { IGNORE_FILE, RECOVERED_FOLDER, stampOf } from "../folder/session.ts";
import {
  isSettled,
  reconcileItems,
  replacedCounts,
  type ReconcileChoices,
  type ReconcileSide,
} from "./reconcile.ts";
import { settleTakeBack, type ChooseTakeBack, type TakeBackOutcome } from "./take-back.ts";

/**
 * Asks people which side each file that the merge could not settle is to be, see `TakeBackPlan`,
 * until what they chose goes together. Undefined where they did not choose.
 */
export const chooseTakeBack =
  ({ dialogs, t, name }: { dialogs: Dialogs; t: TFunction; name: string }): ChooseTakeBack =>
  async (plan) => {
    const words = "cloud.takeBack" as const;
    let choices: ReconcileChoices = new Map(
      reconcileItems(plan.differences, new Map(), t, { now: Date.now(), words }).map((item) => [
        item.path,
        item.value as ReconcileSide,
      ]),
    );
    let error: string | undefined;
    const summarize = (values: FormAnswer) => {
      const { cloud, here } = replacedCounts(
        plan.differences,
        new Map(plan.differences.map(({ path }) => [path, values[path] as ReconcileSide])),
      );
      return {
        text: t(`${words}.summary`, { cloud, here }),
        confirm:
          cloud > 0 ? t(`${words}.confirmReplacing`, { count: cloud }) : t(`${words}.confirm`),
        loud: cloud > 0,
      };
    };
    for (;;) {
      // Where both had something in common, a file both have is one both changed in one place.
      const items = reconcileItems(plan.differences, choices, t, { now: Date.now(), words }).map(
        (item) =>
          plan.base && plan.differences.find(({ path }) => path === item.path)?.kind === "both"
            ? { ...item, status: t(`${words}.newerHere`) }
            : item,
      );
      const answer = await dialogs.reconcile({
        title: t(`${words}.title`, { name, interpolation: { escapeValue: false } }),
        message: [
          t(plan.base ? `${words}.message` : `${words}.messageNoBase`, {
            count: plan.differences.length,
          }),
        ].join(""),
        items,
        all: [
          { id: "here", label: t(`${words}.allHere`) },
          { id: "cloud", label: t(`${words}.allCloud`) },
        ],
        notes: [
          ...(plan.merged.length > 0 ? [t(`${words}.merged`, { count: plan.merged.length })] : []),
          t(`${words}.noteKept`),
        ],
        ...(error !== undefined && { error }),
        confirm: t(`${words}.confirm`),
        summarize,
      });
      if (!answer) return undefined;
      choices = new Map(plan.differences.map(({ path }) => [path, answer[path] as ReconcileSide]));
      const settled = settleTakeBack(plan, choices);
      if (isSettled(settled)) return { choices, settled };
      error = t(`${words}.unsettled`, {
        problems: [
          ...(settled.failure ? [commandFailedText(t, settled.failure)] : []),
          ...settled.problems.slice(0, 5).map((problem) => problemText(t, problem)),
        ].join("；"),
        interpolation: { escapeValue: false },
      });
    }
  };

/** A problem of a file, the way people read it in a line. */
const problemText = (t: TFunction, { file, path, message }: Problem): string =>
  t("transfer.problem", { place: path ? `${file} ${path}` : file, message });

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Keeps what the folder has of these files in a folder of its own in `RECOVERED_FOLDER`, each read
 * back, before taking a copy back changes them. Resolves to where, or undefined where the folder has
 * none of them; rejects where any could not be kept as it was.
 */
export async function keepFolderFiles(
  folder: LocalFolder,
  paths: readonly string[],
  now: number,
): Promise<string | undefined> {
  const found: { readonly path: string; readonly content: Uint8Array<ArrayBuffer> }[] = [];
  for (const path of paths) {
    try {
      found.push({ path, content: await folder.read(path) });
    } catch (error) {
      // Not there is nothing to keep; anything else is no way to go on.
      if (!(error instanceof FolderError && error.reason === "missing")) throw error;
    }
  }
  if (found.length === 0) return undefined;
  try {
    await folder.write(IGNORE_FILE, "*\n", { expected: "absent" });
  } catch (error) {
    if (!(
      error instanceof FolderError &&
      (error.reason === "changed" || error.reason === "exists")
    ))
      throw error;
  }
  const stamp = stampOf(now);
  for (let number = 1; number <= 100; number++) {
    const place = `${RECOVERED_FOLDER}/${stamp}-rebuilt${number === 1 ? "" : `-${number}`}`;
    let isFree = true;
    for (const { path } of found) {
      if (
        await folder.file(`${place}/${path}`).then(
          () => true,
          () => false,
        )
      ) {
        isFree = false;
        break;
      }
    }
    if (!isFree) continue;
    for (const { path, content } of found) {
      const target = `${place}/${path}`;
      await folder.write(target, content, { expected: "absent" });
      if (!sameBytes(await folder.read(target), content)) throw new FolderError("failed", target);
    }
    return place;
  }
  throw new FolderError("failed", RECOVERED_FOLDER);
}

/** Why taking a copy back did not get there, in people's words. */
export function takeBackFailedText(
  outcome: Extract<TakeBackOutcome, { kind: "failed" }>,
  t: TFunction,
): string {
  if (outcome.why === "unreadable") {
    return t("cloud.takeBack.failed.unreadable", {
      problems: (outcome.problems ?? [])
        .slice(0, 5)
        .map((problem) => problemText(t, problem))
        .join("；"),
      interpolation: { escapeValue: false },
    });
  }
  return t(`cloud.takeBack.failed.${outcome.why}`);
}
