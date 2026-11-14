import type { TFunction } from "i18next";
import type { AiCounts } from "../chat/ai-sync.ts";

/** "2 个 AI 服务、5 个模型、1 个适配包", leaving out what there is none of. */
export function countsText(t: TFunction, counts: AiCounts, short = false): string {
  const parts = [
    counts.services > 0 &&
      t(short ? "cloudSync.counts.servicesShort" : "cloudSync.counts.services", {
        count: counts.services,
      }),
    counts.models > 0 && t("cloudSync.counts.models", { count: counts.models }),
    counts.packs > 0 && t("cloudSync.counts.packs", { count: counts.packs }),
  ].filter((part): part is string => typeof part === "string");
  return parts.length > 0
    ? parts.join("、")
    : t(short ? "cloudSync.counts.servicesShort" : "cloudSync.counts.services", { count: 0 });
}

export const hasAny = (counts: AiCounts): boolean =>
  counts.services > 0 || counts.models > 0 || counts.packs > 0;
