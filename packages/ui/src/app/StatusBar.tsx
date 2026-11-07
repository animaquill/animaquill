import { Circle, CircleAlert, CircleX, TriangleAlert, X } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { InputChoice } from "../workbench/input-mode.ts";
import { PreviewStatus } from "../preview/Quality.tsx";
import { FrameRateStatus, TimeStatus } from "../timeline/StatusItems.tsx";
import { duration } from "../export/window.ts";
import { useProject, useSession, useWorkbench } from "./context.ts";
import { Bubble } from "./Bubble.tsx";
import styles from "./StatusBar.module.css";
import { Tip } from "./Tip.tsx";

const CHOICES = ["auto", "mouse", "trackpad", "touch"] as const;

/** Shows what the editor takes the input for, and lets people put it right. */
function InputSwitch() {
  const { input } = useWorkbench();
  const { t } = useTranslation();
  const { choice, device } = useSyncExternalStore(input.subscribe, input.getSnapshot);
  const [anchor, setAnchor] = useState<DOMRect>();
  const close = () => setAnchor(undefined);

  return (
    <>
      <Tip name={t("input.label")} usage={t("input.usage")}>
        <button
          type="button"
          className={styles.name}
          aria-haspopup="dialog"
          aria-label={`${t("input.label")}：${t(`input.${device}`)}`}
          onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        >
          {t(`input.${device}`)}
        </button>
      </Tip>
      {anchor && (
        <Bubble anchor={anchor} title={t("input.label")} onClose={close}>
          <div className={styles.choices} role="radiogroup" aria-label={t("input.label")}>
            {CHOICES.map((id: InputChoice) => (
              <button
                key={id}
                type="button"
                role="radio"
                className={styles.choice}
                aria-checked={choice === id}
                {...(choice === id ? { "data-autofocus": true } : {})}
                onClick={() => {
                  input.choose(id);
                  close();
                }}
              >
                <strong>
                  {id === "auto"
                    ? t("input.autoNow", { device: t(`input.${device}`) })
                    : t(`input.${id}`)}
                </strong>
                <span>{t(`input.about.${id}`)}</span>
              </button>
            ))}
          </div>
        </Bubble>
      )}
    </>
  );
}

/** An export goes on while people work, so this is where they see it and can stop it. */
function VideoExportStatus() {
  const { videos } = useWorkbench();
  const { t } = useTranslation();
  const job = useSyncExternalStore(videos.subscribe, videos.getSnapshot);
  if (!job) return null;
  const { name, done, total, remainingMs, stopping, paused, catchingUp, writing, makingSound } =
    job;
  const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
  const about = t("export.video.runningAbout", {
    file: name,
    done,
    total,
    interpolation: { escapeValue: false },
  });
  return (
    <span className={styles.export} role="status" aria-label={about}>
      <progress className={styles.exportBar} value={done} max={Math.max(total, 1)} />
      <span>
        {stopping
          ? t("export.video.stopping")
          : writing
            ? t("export.video.writing")
            : makingSound
              ? t("export.video.makingSound")
              : catchingUp !== undefined
                ? t("export.resume.catchingUp", { percent: Math.floor(catchingUp * 100) })
                : paused
                  ? t("export.window.pausedStatus", { percent })
                  : t("export.video.running", { percent }) +
                    (remainingMs === undefined
                      ? ""
                      : ` · ${t("export.video.remaining", { time: duration(remainingMs) })}`)}
      </span>
      {paused && !stopping && (
        // The browser only opens the window of the export for a press of a button.
        <button type="button" className={styles.exportResume} onClick={() => videos.resume()}>
          {t("export.window.resume")}
        </button>
      )}
      {!stopping && (
        <Tip name={t("export.video.cancel")} usage={about}>
          <button
            type="button"
            className={styles.exportCancel}
            aria-label={t("export.video.cancel")}
            onClick={() => videos.cancel()}
          >
            <X size={12} />
          </button>
        </Tip>
      )}
    </span>
  );
}

/** Nothing gets recorded without this being on the screen. */
function RecordingStatus() {
  const { diagnostics, layout } = useWorkbench();
  const { t } = useTranslation();
  const recording = useSyncExternalStore(diagnostics.subscribe, diagnostics.getRecording);
  if (!recording) return null;
  return (
    <Tip name={t("diagnostics.recording")} usage={t("diagnostics.recordingUsage")}>
      <button type="button" className={styles.name} onClick={() => layout.openPanel("performance")}>
        <Circle size={9} fill="currentColor" className={styles.recording} />
        {t("diagnostics.recording")}
      </button>
    </Tip>
  );
}

/** How many problems there are, and the way to them. */
function ProblemsStatus() {
  const { layout, problems } = useWorkbench();
  const { t } = useTranslation();
  const { errors, warnings } = useSyncExternalStore(problems.subscribe, problems.getSnapshot);
  return (
    <button
      type="button"
      className={styles.name}
      aria-label={t("problems.status", { errors, warnings })}
      onClick={() => layout.openPanel("problems")}
    >
      <span className={styles.counts}>
        <CircleX size={12} />
        {errors}
        <TriangleAlert size={12} />
        {warnings}
      </span>
    </button>
  );
}

/** The size the project is made at, which is what an export gets. */
function SizeStatus({ width, height }: { width: number; height: number }) {
  const { t } = useTranslation();
  return (
    <Tip name={t("project.size")} usage={t("project.sizeUsage")}>
      <span className={styles.info} aria-label={t("project.sizeLabel", { width, height })}>
        {t("project.sizeValue", { width, height })}
      </span>
    </Tip>
  );
}

/**
 * As in VS Code, the left is about the project and stays much the same: its name, size, frame rate,
 * whether it is saved and how many problems it has. The right is about what goes on right now.
 */
export function StatusBar() {
  const workbench = useWorkbench();
  const { store, save } = useSession();
  const project = useProject(store);
  const { t } = useTranslation();

  const saveText = {
    saved: t("project.saved"),
    saving: t("project.saving"),
    failed: t("project.saveFailed"),
  }[save];
  const format = project?.manifest.formats[0];

  return (
    <footer className={styles.bar}>
      {project ? (
        <button
          type="button"
          className={styles.name}
          onClick={() => void workbench.renameProject()}
        >
          {project.manifest.name}
        </button>
      ) : (
        <span>{t("app.noProject")}</span>
      )}
      {format && <SizeStatus width={format.width} height={format.height} />}
      {project && <FrameRateStatus />}
      {project && (
        <span className={save === "failed" ? styles.failed : undefined} role="status">
          {save === "failed" && <CircleAlert size={12} />}
          {saveText}
        </span>
      )}
      {project && <ProblemsStatus />}
      <span className={styles.spacer} />
      <VideoExportStatus />
      <RecordingStatus />
      {project && <TimeStatus />}
      {project && <PreviewStatus />}
      <InputSwitch />
    </footer>
  );
}
