/**
 * What `CloudProjects` needs around taking a copy back (`take-back.ts`) that is about people:
 * asking them which side files are to be, and why it did not get there.
 */
import type { Problem } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { commandFailedText } from "../i18n/failures.ts";
import type { Dialogs, FormAnswer } from "../workbench/dialogs.ts";
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
