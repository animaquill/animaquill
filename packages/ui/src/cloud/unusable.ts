import type { RepositoryUnusable } from "@animaquill/host";
import type { TFunction } from "i18next";

/**
 * What people are told about a project of the platform whose repository cannot be used, see the
 * design of the start page (docs/design/start-and-cloud.md of AnimaQuill Cloud), 5.1: it cannot be
 * edited, the platform takes it away a week after it found that, and why only decides the words and
 * the ways out. The same words on the card of the start page, in the status bar, the panel of the
 * platform and the bar above the open project. No DOM.
 */

/** Why the repository cannot be used, as people are told. */
export type UnusableKind =
  /** GitHub said that it was deleted. */
  | "deleted"
  /** It is there, and the App may not touch it any more. */
  | "unauthorized"
  /** It cannot be found, and nothing tells why. */
  | "notFound"
  | "transferred"
  /** The App was taken off the account. */
  | "uninstalled"
  | "suspended";

/** What else helps, apart from deleting it and saving it as a project of this computer. */
export type UnusableWay =
  "recheck" | "reauthorize" | "reinstall" | "restoreApp" | "switchRepository";

const DAY_MS = 24 * 3600_000;
const plain = { interpolation: { escapeValue: false } } as const;

export function unusableKind(unusable: Pick<RepositoryUnusable, "reason" | "gone">): UnusableKind {
  switch (unusable.reason) {
    case "transferred":
      return "transferred";
    case "uninstalled":
      return "uninstalled";
    case "suspended":
      return "suspended";
    default:
      return unusable.gone === "deleted"
        ? "deleted"
        : unusable.gone === "unauthorized"
          ? "unauthorized"
          : "notFound";
  }
}

/** Whole days left until the platform takes the project away, none once it is due. */
export function daysLeft(deleteAt: number, now: number): number {
  return Math.max(0, Math.ceil((deleteAt - now) / DAY_MS));
}

/** Why, in a few words: "仓库已删除". */
export function unusableTitle(unusable: Pick<RepositoryUnusable, "reason" | "gone">, t: TFunction) {
  return t(`cloud.unusable.title.${unusableKind(unusable)}`);
}

/** Why, and how long until it goes: "仓库已删除，7 天后自动删除". */
export function unusableLine(unusable: RepositoryUnusable, now: number, t: TFunction): string {
  const what = unusableTitle(unusable, t);
  if (unusable.deleteAt === undefined) return t("cloud.unusable.lineNoDate", { what, ...plain });
  const count = daysLeft(unusable.deleteAt, now);
  return count === 0
    ? t("cloud.unusable.lineToday", { what, ...plain })
    : t("cloud.unusable.line", { what, count, ...plain });
}

/** What people can do about it, in a sentence. */
export function unusableFix(unusable: Pick<RepositoryUnusable, "reason" | "gone">, t: TFunction) {
  return t(`cloud.unusable.fix.${unusableKind(unusable)}`);
}

/**
 * What helps with it, the most likely first, as the design has them for each reason: asking GitHub
 * again always, and another repository too, as long as the platform has something to save there.
 */
export function unusableWays(
  unusable: Pick<RepositoryUnusable, "reason" | "gone">,
  { hasContent = true }: { readonly hasContent?: boolean } = {},
): UnusableWay[] {
  const switching: UnusableWay[] = hasContent ? ["switchRepository"] : [];
  switch (unusableKind(unusable)) {
    case "deleted":
      return ["recheck", ...switching];
    case "unauthorized":
    case "notFound":
      return ["reauthorize", ...switching, "recheck"];
    case "transferred":
      return [...switching, "recheck"];
    case "uninstalled":
      return ["reinstall", "recheck", ...switching];
    case "suspended":
      return ["restoreApp", "recheck", ...switching];
  }
}
