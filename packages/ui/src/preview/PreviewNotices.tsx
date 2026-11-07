import { TriangleAlert } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSession, useWorkbench } from "../app/context.ts";
import type { SceneStatus } from "@animaquill/render";
import type zhCN from "../i18n/zh-CN.json";
import type { TimelineEditor } from "../timeline/editor.ts";
import { sceneClipName } from "./problems.ts";
import styles from "./PreviewNotices.module.css";

type StoppedScene = keyof typeof zhCN.preview.stoppedScene;

const RUNTIME_FAILURES = new Set(["missing-entry", "runtime-load"]);

function Notice({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className={styles.notice} role="status">
      <TriangleAlert size={14} className={styles.icon} />
      <span className={styles.text}>{children}</span>
      {actions}
    </div>
  );
}

function useClipName(timeline: TimelineEditor) {
  const { t } = useTranslation();
  const { store } = useSession();
  return (clip: string) =>
    sceneClipName(timeline.model?.boxes.get(clip)?.clip, store?.getState(), t);
}

/** What people should know about the picture, on top of it, and what they can do about it. */
export function PreviewNotices({ onRetry }: { onRetry: (clip: string) => void }) {
  const { preview, timeline } = useWorkbench();
  const { t } = useTranslation();
  const { compositor, runScenes, scenes } = useSyncExternalStore(
    preview.subscribe,
    preview.getSnapshot,
  );
  const nameOf = useClipName(timeline);

  const words = (clip: string, { state, reason, message = "" }: SceneStatus) => {
    const name = nameOf(clip);
    if (state === "too-new") return t("preview.tooNew", { name });
    if (state === "retrying") return t("preview.retrying", { name });
    // What a scene says about itself can be a code of the runtime, which has words of its own.
    const said = reason === "failed" && RUNTIME_FAILURES.has(message) ? message : reason;
    return t(`preview.stoppedScene.${(said ?? "silent") as StoppedScene}`, {
      name,
      message,
      interpolation: { escapeValue: false },
    });
  };

  const all = [...scenes];
  const unsupported = all.some(([, { state }]) => state === "unsupported");
  // That goes for all scenes, and there is no use in trying again.
  const noOrigin = all.some(([, { reason }]) => reason === "no-origin");
  const others = all.filter(
    ([, { state, reason }]) =>
      reason !== "no-origin" &&
      (state === "stopped" || state === "retrying" || state === "too-new"),
  );

  if (compositor === "stopped") {
    return (
      <div className={styles.notices}>
        <Notice
          actions={
            <>
              <button type="button" onClick={() => preview.restart()}>
                {t("preview.restart")}
              </button>
              <button type="button" onClick={() => preview.restart({ runScenes: false })}>
                {t("preview.restartWithoutScenes")}
              </button>
            </>
          }
        >
          {t("preview.stopped")}
        </Notice>
      </div>
    );
  }

  return (
    <div className={styles.notices}>
      {!runScenes && (
        <Notice
          actions={
            <button type="button" onClick={() => preview.restart({ runScenes: true })}>
              {t("preview.restartWithScenes")}
            </button>
          }
        >
          {t("preview.scenesOff")}
        </Notice>
      )}
      {unsupported && <Notice>{t("preview.unsupported")}</Notice>}
      {noOrigin && (
        <Notice
          actions={
            <button type="button" onClick={() => location.reload()}>
              {t("preview.reload")}
            </button>
          }
        >
          {t("preview.noOrigin")}
        </Notice>
      )}
      {others.map(([clip, status]) => (
        <Notice
          key={clip}
          {...(status.state === "stopped" && {
            actions: (
              <button type="button" onClick={() => onRetry(clip)}>
                {t("preview.retry")}
              </button>
            ),
          })}
        >
          {words(clip, status)}
        </Notice>
      ))}
    </div>
  );
}
