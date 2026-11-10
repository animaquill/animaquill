import { Circle, CircleAlert, CircleX, Download, Pause, TriangleAlert, X } from "lucide-react";
import type { TFunction } from "i18next";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { FolderTrouble } from "../folder/session.ts";
import type { OpenFolder, ProjectFoldersSnapshot } from "../workbench/project-folders.ts";
import type { InputChoice } from "../workbench/input-mode.ts";
import { NO_PROXIES } from "../proxy/proxies.ts";
import { PreviewStatus } from "../preview/Quality.tsx";
import { FrameRateStatus, TimeStatus } from "../timeline/StatusItems.tsx";
import { duration } from "../export/window.ts";
import { useProject, useSession, useWorkbench } from "./context.ts";
import { Bubble } from "./Bubble.tsx";
import { OperationStatus } from "./OperationStatus.tsx";
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

/**
 * An export goes on while people work, so this is where they see it, and can pause or stop it. It
 * says what it waits for, and how many more are in line; the list of them is a press away.
 */
function VideoExportStatus() {
  const { videos, layout } = useWorkbench();
  const { t } = useTranslation();
  const job = useSyncExternalStore(videos.subscribe, videos.getSnapshot);
  const entries = useSyncExternalStore(videos.queue.subscribe, videos.queue.getSnapshot);
  const openList = () => layout.openPanel("exports");
  if (!job) {
    const unfinished = entries.filter(({ status }) => status !== "done").length;
    if (unfinished === 0) return null;
    return (
      <Tip name={t("panel.exports.title")} usage={t("export.queue.idleUsage")}>
        <button type="button" className={styles.name} onClick={openList}>
          <Download size={12} />
          {t("export.queue.idle", { count: unfinished })}
        </button>
      </Tip>
    );
  }
  const { name, done, total, remainingMs, stopping, paused, catchingUp, writing, makingSound } =
    job;
  const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
  const more = videos.queue.waiting();
  const about = t("export.video.runningAbout", {
    file: name,
    done,
    total,
    interpolation: { escapeValue: false },
  });
  const canPause = !stopping && !writing && !job.pausing && !paused;
  return (
    <span className={styles.export} role="status" aria-label={about}>
      <progress className={styles.exportBar} value={done} max={Math.max(total, 1)} />
      <button type="button" className={styles.exportText} onClick={openList}>
        {stopping
          ? t("export.video.stopping")
          : writing
            ? t("export.video.writing")
            : job.pausing
              ? t("export.queue.status.pausing")
              : makingSound
                ? t("export.video.makingSound")
                : catchingUp !== undefined
                  ? t("export.resume.catchingUp", { percent: Math.floor(catchingUp * 100) })
                  : paused
                    ? t("export.window.pausedStatus", { percent })
                    : job.readingMedia
                      ? t("export.queue.status.readingMedia")
                      : job.hidden
                        ? t("export.queue.status.hidden")
                        : t("export.video.running", { percent }) +
                          (remainingMs === undefined
                            ? ""
                            : ` · ${t("export.video.remaining", { time: duration(remainingMs) })}`)}
        {more > 0 && ` · ${t("export.queue.more", { count: more })}`}
      </button>
      {paused && !stopping && (
        // The browser only opens the window of the export for a press of a button.
        <button type="button" className={styles.exportResume} onClick={() => videos.resume()}>
          {t("export.window.resume")}
        </button>
      )}
      {canPause && (
        <Tip name={t("export.queue.pause")} usage={t("export.queue.status.pausing")}>
          <button
            type="button"
            className={styles.exportCancel}
            aria-label={t("export.queue.pause")}
            onClick={() => videos.pause()}
          >
            <Pause size={12} />
          </button>
        </Tip>
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

/**
 * A proxy on its way, which goes on while people work, as an export does: how far, how many more,
 * and the way to stop it. It says so when it waits for something to stop playing.
 */
function ProxyStatus() {
  const { proxies, layout, session } = useWorkbench();
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(
    proxies?.subscribe ?? noSubscription,
    proxies?.getSnapshot ?? noProxies,
  );
  const { making, waiting, paused, elsewhere } = snapshot;
  if (!proxies) return null;
  if (!making) {
    if (!elsewhere || waiting === 0) return null;
    return (
      <Tip name={t("proxy.status.elsewhere")} usage={t("proxy.status.usage")}>
        <span className={styles.info} role="status">
          {t("proxy.status.elsewhere")}
        </span>
      </Tip>
    );
  }
  const { percent } = making;
  const asset = Object.values(session.store?.getState().assets ?? {}).find(
    ({ hash }) => hash === making.hash,
  );
  const about = t("proxy.status.about", {
    name: asset?.name ?? asset?.path ?? "",
    interpolation: { escapeValue: false },
  });
  const text =
    (paused ? t("proxy.status.paused", { percent }) : t("proxy.status.making", { percent })) +
    (waiting > 0 ? ` · ${t("proxy.status.more", { count: waiting })}` : "");
  return (
    <span className={styles.export} role="status" aria-label={about}>
      <progress className={styles.exportBar} value={percent} max={100} />
      <Tip name={about} usage={t("proxy.status.usage")}>
        <button
          type="button"
          className={styles.exportText}
          onClick={() => layout.openPanel("explorer")}
        >
          {text}
        </button>
      </Tip>
      <Tip name={t("proxy.stop")} usage={t("proxy.status.stopAll")}>
        <button
          type="button"
          className={styles.exportCancel}
          aria-label={t("proxy.stop")}
          onClick={() => proxies.stop()}
        >
          <X size={12} />
        </button>
      </Tip>
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

const noSubscription = () => () => {};
const noProxies = () => NO_PROXIES;
const NO_FOLDERS: ProjectFoldersSnapshot = { open: undefined, waiting: undefined, moves: 0 };
const noFolders = () => NO_FOLDERS;
const writtenWhen = new Intl.DateTimeFormat("zh-CN", { timeStyle: "medium" });

/** What keeps changes from a project folder, in words. */
function troubleText(trouble: FolderTrouble, t: TFunction): string {
  switch (trouble.reason) {
    case "gone":
    case "replaced":
    case "manifest-gone":
    case "outdated":
    case "too-new":
    case "denied":
    case "full":
      return t(`folder.trouble.${trouble.reason}`);
    case "busy":
    case "too-long":
    case "clash":
      return t(`folder.trouble.${trouble.reason}`, {
        path: trouble.path,
        interpolation: { escapeValue: false },
      });
    default:
      return t("folder.trouble.other", {
        path: trouble.path,
        interpolation: { escapeValue: false },
      });
  }
}

/**
 * Whether the project folder has everything, as the save status of a project that is a folder:
 * what keeps changes from it, and the one thing that helps, right there.
 */
function FolderSaveStatus({ open }: { open: OpenFolder }) {
  const { projectFolders, layout } = useWorkbench();
  const { t } = useTranslation();
  const { record, snapshot } = open;
  const { role, status, trouble, blocked, writtenAt, unrecorded } = snapshot;
  if (!projectFolders) return null;
  const about =
    writtenAt === undefined
      ? t("folder.folderName", { folder: record.folder.name })
      : t("folder.writtenAt", { folder: record.folder.name, time: writtenWhen.format(writtenAt) });
  const text =
    role === "starting"
      ? t("folder.status.starting")
      : status === "unsaved" && trouble
        ? troubleText(trouble, t)
        : t(`folder.status.${status}`);
  const fix =
    trouble?.reason === "gone" || trouble?.reason === "replaced"
      ? { label: t("folder.findAgain"), run: () => void projectFolders.findAgain(record) }
      : trouble?.reason === "denied"
        ? { label: t("folder.allowAgain"), run: () => void projectFolders.allowAgain() }
        : trouble?.reason === "manifest-gone"
          ? { label: t("folder.restore"), run: () => void projectFolders.writeEditorContent() }
          : trouble?.reason === "outdated" || trouble?.reason === "too-new"
            ? { label: t("folder.reload"), run: () => location.reload() }
            : undefined;
  const isTrouble = status === "unsaved";
  return (
    <>
      <Tip name={text} usage={isTrouble ? t("folder.troubleAbout") : about}>
        <span className={isTrouble ? styles.failed : undefined} role="status">
          {isTrouble && <CircleAlert size={12} />}
          {text}
        </span>
      </Tip>
      {fix && (
        <button type="button" className={styles.name} onClick={fix.run}>
          {fix.label}
        </button>
      )}
      {trouble?.reason === "gone" && (
        // Deleted, not moved: what the browser has goes to a new place.
        <button
          type="button"
          className={styles.name}
          onClick={() => void projectFolders.saveElsewhere(record)}
        >
          {t("folder.saveElsewhere")}
        </button>
      )}
      {blocked.length > 0 && (
        <button
          type="button"
          className={`${styles.name} ${styles.failed}`}
          onClick={() => layout.openPanel("problems")}
        >
          {t("folder.blockedCount", { count: blocked.length })}
        </button>
      )}
      {unrecorded && (
        <span className={styles.failed} role="status">
          <TriangleAlert size={12} />
          {t("folder.unrecorded")}
        </span>
      )}
    </>
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
  const { projectFolders } = workbench;
  const { open } = useSyncExternalStore(
    projectFolders?.subscribe ?? noSubscription,
    projectFolders?.getSnapshot ?? noFolders,
  );
  // A project folder says what it has; the log only when it cannot keep changes.
  const folder = open && open.snapshot && store ? open : undefined;

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
      {project && folder && <FolderSaveStatus open={folder} />}
      {project && (!folder || save === "failed") && (
        <span className={save === "failed" ? styles.failed : undefined} role="status">
          {save === "failed" && <CircleAlert size={12} />}
          {saveText}
        </span>
      )}
      {project && <ProblemsStatus />}
      <span className={styles.spacer} />
      {project && <OperationStatus />}
      {project && <ProxyStatus />}
      <VideoExportStatus />
      <RecordingStatus />
      {project && <TimeStatus />}
      {project && <PreviewStatus />}
      <InputSwitch />
    </footer>
  );
}
