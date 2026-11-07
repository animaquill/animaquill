import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Tip } from "../app/Tip.tsx";
import { useSession, useWorkbench } from "../app/context.ts";
import { PreviewLink } from "../preview/link.ts";
import { PreviewNotices } from "../preview/PreviewNotices.tsx";
import { formatTimecode, frameAt } from "../timeline/frames.ts";
import { ToolButton } from "../timeline/ToolButton.tsx";
import styles from "./PreviewPanel.module.css";

/**
 * The compositor. A new one of these is the only way out of one that hangs: going to another address
 * would have to wait for it. Everything it knows comes from the link when it says hello.
 */
function Compositor({ onLink }: { onLink: (link: PreviewLink | undefined) => void }) {
  const workbench = useWorkbench();
  const { timeline, properties, projects, media, compositorUrl, notifications, diagnostics } =
    workbench;
  const { preview, sceneOrigins, sceneStage } = workbench;
  const { t } = useTranslation();
  const { store } = useSession();
  const { runScenes } = useSyncExternalStore(preview.subscribe, preview.getSnapshot);
  const picture = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const element = picture.current;
    if (!element || !store) return;
    const warned = new Set<string>();
    const onProblem = (file: string) => {
      if (!warned.has(file)) notifications.push(t("notice.previewCannotDecode"));
      warned.add(file);
    };
    const compositor = new URL(compositorUrl, location.href).origin;
    const link = new PreviewLink(
      element,
      timeline,
      properties,
      store,
      projects,
      onProblem,
      diagnostics,
      media,
      preview,
      {
        origins: sceneOrigins,
        compositor,
        run: runScenes,
        ...(sceneStage && { stage: sceneStage }),
      },
    );
    onLink(link);
    // The compositor says hello once it has loaded, so the link has to listen first.
    element.src = compositorUrl;
    return () => {
      link.dispose();
      onLink(undefined);
    };
  }, [
    compositorUrl,
    diagnostics,
    media,
    notifications,
    onLink,
    preview,
    projects,
    properties,
    runScenes,
    sceneOrigins,
    sceneStage,
    store,
    t,
    timeline,
  ]);

  return (
    <iframe
      ref={picture}
      className={styles.picture}
      title={t("panel.preview.title")}
      // Thumbnails and sounds have compositors of their own, at the same address: this is the one.
      data-compositor="preview"
      // No same-origin: what runs there has no way into the editor.
      sandbox="allow-scripts"
      tabIndex={-1}
    />
  );
}

export function PreviewPanel() {
  const { timeline, preview, trials } = useWorkbench();
  const { t } = useTranslation();
  const { playing, model } = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot);
  const frame = useSyncExternalStore(timeline.subscribeView, () => timeline.frame);
  const { compositor, generation } = useSyncExternalStore(preview.subscribe, preview.getSnapshot);
  const { count, comparing } = useSyncExternalStore(trials.subscribe, trials.getSnapshot);
  const link = useRef<PreviewLink>(undefined);
  const onLink = useCallback((current: PreviewLink | undefined) => {
    link.current = current;
  }, []);

  return (
    <div className={styles.panel}>
      <div className={styles.stage}>
        {/* One that hangs goes on taking a whole core, for as long as its frame is there. */}
        {compositor !== "stopped" && compositor !== "unreachable" && (
          <Compositor key={generation} onLink={onLink} />
        )}
        <PreviewNotices onRetry={(layer) => link.current?.retryScene(layer)} />
        {count > 0 && (
          <div className={styles.showing} data-comparing={comparing || undefined} role="status">
            {comparing ? t("trial.showingSaved") : t("trial.showingTrial")}
          </div>
        )}
      </div>
      <div className={styles.transport} role="toolbar" aria-label={t("timeline.transport")}>
        <div className={styles.buttons}>
          <ToolButton
            name={t("timeline.action.previousFrame")}
            usage={t("timeline.help.previousFrame")}
            action="previousFrame"
            icon={SkipBack}
            onClick={() => timeline.stepFrames(-1)}
          />
          <ToolButton
            name={playing ? t("timeline.pause") : t("timeline.play")}
            usage={t("timeline.help.play")}
            action="play"
            icon={playing ? Pause : Play}
            onClick={() => timeline.togglePlayback()}
          />
          <ToolButton
            name={t("timeline.action.nextFrame")}
            usage={t("timeline.help.nextFrame")}
            action="nextFrame"
            icon={SkipForward}
            onClick={() => timeline.stepFrames(1)}
          />
        </div>
        {model && (
          <Tip name={t("timeline.time")} usage={t("timeline.timeFormat")}>
            <span className={styles.time}>
              <output aria-live="off">{formatTimecode(frame, model.rate)}</output>
              <span>| {formatTimecode(frameAt(model.duration, model.rate), model.rate)}</span>
            </span>
          </Tip>
        )}
      </div>
    </div>
  );
}
