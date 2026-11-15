import type { TFunction } from "i18next";
import { formatSize } from "../transfer/transfer.ts";
import type { DownloadItem, DownloadProblem } from "./downloads.ts";
import { percentOf } from "./upload-text.ts";

/** Why a file did not come, in words. */
export function downloadProblemText(
  t: TFunction,
  item: Pick<DownloadItem, "problem" | "need">,
): string {
  const problem: DownloadProblem = item.problem ?? "refused";
  if (problem === "space")
    return item.need === undefined
      ? t("storage.downloads.problem.spaceUnknown")
      : t("storage.downloads.problem.space", { size: formatSize(item.need) });
  return t(`storage.downloads.problem.${problem}`);
}

/** The state of a file in a list, short: "排队", "62% · 12 MB/s", "离线，联网后接着下"… */
export function downloadPhaseText(t: TFunction, item: DownloadItem): string {
  switch (item.phase) {
    case "downloading":
      return item.speed === undefined
        ? t("storage.downloads.phase.downloadingSlow", { percent: percentOf(item) })
        : t("storage.downloads.phase.downloading", {
            percent: percentOf(item),
            speed: formatSize(item.speed),
          });
    case "uploading":
      return t("storage.downloads.phase.uploading", {
        percent: item.uploading ? percentOf(item.uploading) : 0,
      });
    case "failed":
      return downloadProblemText(t, item);
    default:
      return t(`storage.downloads.phase.${item.phase}`);
  }
}

/** What a failure asks of people, as the button that does it says: undefined for nothing but trying again. */
export const downloadFix = (
  item: Pick<DownloadItem, "phase" | "problem">,
  inBrowser: boolean,
): "quota" | "problems" | "allow" | "signIn" | "folder" | undefined => {
  if (item.phase === "access") return "allow";
  if (item.phase !== "failed") return undefined;
  switch (item.problem) {
    case "githubQuota":
      return "quota";
    case "occupied":
      return "problems";
    case "signedOut":
      return "signIn";
    case "space":
      return inBrowser ? "folder" : undefined;
    default:
      return undefined;
  }
};
