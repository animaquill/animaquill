import type { TFunction } from "i18next";
import { formatSize } from "../transfer/transfer.ts";
import type { UploadItem } from "./uploads.ts";

/** Whole percent of a file the platform has. */
export const percentOf = (item: Pick<UploadItem, "received" | "size">): number =>
  item.size === 0 ? 100 : Math.min(100, Math.floor((item.received / item.size) * 100));

/** How long is left, in words, where it is known: "约 3 分钟". */
export function etaText(
  t: TFunction,
  bytesLeft: number,
  speed: number | undefined,
): string | undefined {
  if (speed === undefined || speed <= 0 || bytesLeft <= 0) return undefined;
  const seconds = bytesLeft / speed;
  if (seconds < 60) return t("storage.uploads.eta.soon");
  if (seconds < 3600) return t("storage.uploads.eta.minutes", { count: Math.ceil(seconds / 60) });
  return t("storage.uploads.eta.hours", { count: Math.ceil(seconds / 3600) });
}

/** "45% · 132 MB / 290 MB · 约 1 分钟". */
export function progressText(
  t: TFunction,
  item: Pick<UploadItem, "received" | "size" | "speed">,
): string {
  const values = {
    percent: percentOf(item),
    done: formatSize(item.received),
    total: formatSize(item.size),
  };
  const eta = etaText(t, item.size - item.received, item.speed);
  return eta === undefined
    ? t("storage.uploads.row.progress", values)
    : t("storage.uploads.row.progressEta", { ...values, eta });
}

/**
 * The numbers a failure is said with, where the storage has them: the largest file (`most`) and all
 * of it together (`max`), as a server of its own is set up for. See `Workbench.uploadLimitWords`.
 */
export type UploadLimitWords = { readonly most: string; readonly max: string };

/** The state of a file in a list, short: "排队", "62% · 12 MB/s", "离线，联网后接着传"… */
export function phaseText(t: TFunction, item: UploadItem, limits?: UploadLimitWords): string {
  switch (item.phase) {
    case "sending":
      return item.speed === undefined
        ? t("storage.uploads.phase.sendingSlow", { percent: percentOf(item) })
        : t("storage.uploads.phase.sending", {
            percent: percentOf(item),
            speed: formatSize(item.speed),
          });
    case "failed":
      return t(`storage.uploads.problem.${item.problem ?? "refused"}`, limits ?? {});
    case "blocked":
      return t("storage.uploads.phase.queued");
    case "busy":
      return item.diskFull
        ? t("storage.uploads.phase.busyDisk")
        : item.full
          ? t("storage.uploads.phase.busyFull")
          : t("storage.uploads.phase.busy");
    default:
      return t(`storage.uploads.phase.${item.phase}`);
  }
}

/** What is going on now, in phases that are not over and not stopped by people. */
export const isGoing = (item: UploadItem): boolean =>
  ["queued", "reading", "sending", "checking", "pushing", "offline", "busy", "blocked"].includes(
    item.phase,
  );

/** Failures that people have to do something about, which the status stands out for. */
export const needsPeople = (item: UploadItem): boolean =>
  item.phase === "failed" &&
  ["githubQuota", "notAcknowledged", "changed", "access", "missing", "signedOut"].includes(
    item.problem ?? "",
  );
