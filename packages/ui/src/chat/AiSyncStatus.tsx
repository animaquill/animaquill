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

/** One line on top of the page of AI models: how they stand with the account, where they go. */
export function AiSyncLine({ className, link }: { className: string; link: string }) {
  const { aiSync } = useWorkbench();
  const { t } = useTranslation();
  const { text, snapshot } = useAiSyncText();
  if (snapshot.account === undefined) return null;
  return (
    <p className={className} data-testid="ai-sync-line" data-status={snapshot.status}>
      {t("aiSync.line", { status: text })}
      {(snapshot.status === "failed" || snapshot.status === "offline") && (
        <>
          {" "}
          <button type="button" className={link} onClick={() => aiSync.retry()}>
            {t("aiSync.retry")}
          </button>
        </>
      )}
    </p>
  );
}
