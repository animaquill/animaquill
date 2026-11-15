import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { agoText } from "../app/start-view.ts";
import type { AiSyncSnapshot } from "./ai-sync.ts";

/** How the AI settings stand with the account, in a few words, see `AiSync`. */
export function useAiSyncText(): { readonly text: string; readonly snapshot: AiSyncSnapshot } {
  const { aiSync } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(aiSync.subscribe, aiSync.getSnapshot);
  // "2 分钟前" moves on by itself.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const { status, syncedAt } = snapshot;
  const text =
    status === "synced" && syncedAt !== undefined
      ? t("aiSync.status.syncedAgo", { ago: agoText(syncedAt, Math.max(now, syncedAt), t) })
      : t(`aiSync.status.${status}`);
  return { text, snapshot };
}
