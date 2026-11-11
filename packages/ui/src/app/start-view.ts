import type { FolderStatus } from "@animaquill/host";
import type { TFunction } from "i18next";
import {
  cloudRowNotes,
  markHint,
  markText,
  type CloudRow,
  type LocalRow,
} from "../cloud/start-list.ts";
import { httpsLink } from "./links.ts";

/**
 * What the lines of the start page say and offer, from what `StartList` found, see the design of
 * the start page (docs/design/start-and-cloud.md of AnimaQuill Cloud), 2. No DOM, so that tests
 * read what people read.
 */

const plain = { interpolation: { escapeValue: false } } as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const startOfDay = (at: number): number => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/**
 * How long ago something was, as people say it of a project: "刚刚", "3 分钟前", "2 小时前" for
 * today, "昨天", "3 天前" within a week, and the day after that, with the year where it is another.
 */
export function agoText(at: number, now: number, t: TFunction): string {
  const passed = now - at;
  // A clock that is a little off must not say "in the future".
  if (passed < MINUTE) return t("start.ago.now");
  const days = Math.round((startOfDay(now) - startOfDay(at)) / (24 * HOUR));
  if (days <= 0) {
    return passed < HOUR
      ? t("start.ago.minutes", { count: Math.floor(passed / MINUTE) })
      : t("start.ago.hours", { count: Math.floor(passed / HOUR) });
  }
  if (days === 1) return t("start.ago.yesterday");
  if (days < 7) return t("start.ago.days", { count: days });
  const when = new Date(at);
  const day = t("start.ago.day", { month: when.getMonth() + 1, day: when.getDate() });
  return when.getFullYear() === new Date(now).getFullYear()
    ? day
    : t("start.ago.dayOfYear", { year: when.getFullYear(), day });
}

export interface LocalRowView {
  /** Where it is: its folder, or that the folder cannot be found, or cannot be read. */
  readonly place: string;
  /** How it stands with the platform, or undefined where the editor is hosted on none. */
  readonly mark: string | undefined;
  /** What the mark means, for hovering. */
  readonly hint: string | undefined;
  /** People have to do something about it on the platform. */
  readonly attention: boolean;
  /** The folder is not where it was: it can be found again, or what the browser has saved elsewhere. */
  readonly gone: boolean;
}

/** `status`: how its folder is, once that is known; looking can take a while, as on a network. */
export function localRowView(
  row: LocalRow,
  status: FolderStatus | undefined,
  t: TFunction,
): LocalRowView {
  const { mark } = row;
  return {
    place:
      status === undefined || status === "ready"
        ? t("folder.folderLabel", { folder: row.folder, ...plain })
        : t(`folder.recentStatus.${status}`),
    mark:
      mark === undefined
        ? undefined
        : // Changes that the platform may not have yet say so on the line, as for its own projects.
          row.pending && mark.kind === "linked"
          ? `${markText(mark, t)} · ${t("start.pending")}`
          : markText(mark, t),
    hint: mark && markHint(mark, t),
    attention: mark?.kind === "attention" || mark?.kind === "noRepository",
    gone: status === "gone",
  };
}

/** What "更多" of a project of the platform offers. */
export type CloudRowMore = "openOnGitHub" | "removeHere" | "deleteCloud";

export interface CloudRowView {
  /** What the line says under the name, in order: its repository, when it changed, and what else. */
  readonly about: readonly string[];
  /** What people have to do about it, where there is something: "☁ 要处理", "还差一步：选仓库". */
  readonly mark: string | undefined;
  readonly hint: string | undefined;
  /** "下载到文件夹…" is there: this browser can write folders. */
  readonly download: boolean;
  readonly more: readonly CloudRowMore[];
  /** Where "在 GitHub 上打开" goes: the platform's word, and only an https address. */
  readonly address: string | undefined;
}

export interface CloudRowContext {
  readonly now: number;
  /** This browser can write folders. */
  readonly canDownload: boolean;
}

export function cloudRowView(
  row: CloudRow,
  { now, canDownload }: CloudRowContext,
  t: TFunction,
): CloudRowView {
  const { mark } = row;
  // That it is connected goes without saying here; only what is not as it should be shows.
  const isPlain = mark.kind === "linked" || mark.kind === "local";
  const address = httpsLink(row.repository?.url);
  return {
    about: [
      ...(row.repository ? [row.repository.fullName] : []),
      ...(row.updatedAt === undefined
        ? []
        : [t("start.changed", { time: agoText(row.updatedAt, now, t), ...plain })]),
      ...cloudRowNotes(row, t),
    ],
    mark: isPlain ? undefined : markText(mark, t),
    hint: markHint(mark, t),
    download: canDownload,
    more: [
      ...(address ? (["openOnGitHub"] as const) : []),
      // What it says before anything goes is the removing's to say: that the platform may not
      // have the project, or that it cannot tell.
      ...(row.key !== undefined ? (["removeHere"] as const) : []),
      ...(row.deletable ? (["deleteCloud"] as const) : []),
    ],
    address,
  };
}
