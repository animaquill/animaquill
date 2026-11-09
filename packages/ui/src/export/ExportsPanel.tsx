import {
  CircleAlert,
  CircleCheck,
  CirclePause,
  Clock,
  LoaderCircle,
  Pause,
  Play,
  RotateCw,
  X,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ProjectSummary } from "@animaquill/host";
import { useSession, useWorkbench } from "../app/context.ts";
import type { QueueEntry } from "./queue.ts";
import type { VideoJob } from "./video.ts";
import { duration } from "./window.ts";
import styles from "./ExportsPanel.module.css";
import { projectKeyOf } from "../workbench/session.ts";

const PLAIN = { interpolation: { escapeValue: false } } as const;

/** What an export is doing, in a few words: what it waits for when it waits. */
export function describeEntry(
  t: TFunction,
  entry: QueueEntry,
  job: VideoJob | undefined,
  ahead: number,
  otherProject: string | undefined,
): string {
  const frames = (done: number, total: number) =>
    total > 0 ? t("export.queue.frames", { done, total }) : t("export.queue.framesOnly", { done });
  switch (entry.status) {
    case "running": {
      if (!job) return t("export.queue.status.running", { percent: 0 });
      const { done, total, remainingMs } = job;
      const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
      const what = job.stopping
        ? t("export.video.stopping")
        : job.writing
          ? t("export.video.writing")
          : job.pausing
            ? t("export.queue.status.pausing")
            : job.paused
              ? t("export.queue.status.windowClosed")
              : job.makingSound
                ? t("export.video.makingSound")
                : job.catchingUp !== undefined
                  ? t("export.resume.catchingUp", { percent: Math.floor(job.catchingUp * 100) })
                  : job.readingMedia
                    ? t("export.queue.status.readingMedia")
                    : job.hidden
                      ? t("export.queue.status.hidden")
                      : t("export.queue.status.running", { percent });
      const left =
        remainingMs === undefined || job.paused
          ? ""
          : ` · ${t("export.video.remaining", { time: duration(remainingMs) })}`;
      return `${what} · ${frames(done, total)}${left}`;
    }
    case "waiting":
      if (otherProject !== undefined) {
        return t("export.queue.status.otherProject", { project: otherProject, ...PLAIN });
      }
      if (entry.restored) return t("export.queue.status.waitingRestored");
      return ahead <= 1
        ? t("export.queue.status.waitingNext")
        : t("export.queue.status.waiting", { ahead });
    case "paused":
      return `${t(entry.needsPress ? "export.queue.status.needsPress" : "export.queue.status.paused")} · ${frames(entry.done, entry.total)}`;
    case "failed":
      return t("export.queue.status.failed", { failure: entry.failure ?? "", ...PLAIN });
    case "interrupted":
      return `${t("export.queue.status.interrupted")} · ${frames(entry.done, entry.total)}`;
    case "done":
      return t("export.queue.status.done");
  }
}

const ICONS = {
  waiting: Clock,
  running: LoaderCircle,
  paused: CirclePause,
  failed: CircleAlert,
  interrupted: CirclePause,
  done: CircleCheck,
} as const;

function Row({
  entry,
  projects,
}: {
  entry: QueueEntry;
  projects: readonly ProjectSummary[] | undefined;
}) {
  const { videos } = useWorkbench();
  const { store } = useSession();
  const { t } = useTranslation();
  const job = useSyncExternalStore(videos.subscribe, videos.getSnapshot);
  const live = entry.status === "running" && job?.id === entry.id ? job : undefined;
  const open = store && projectKeyOf(store);
  const projectName = projects?.find(({ id }) => id === entry.project)?.name;
  const elsewhere = entry.project !== open;
  const waitsForProject =
    elsewhere && (entry.status === "waiting" || entry.status === "interrupted") && !entry.restored;
  const text = describeEntry(
    t,
    entry,
    live,
    videos.queue.ahead(entry.id),
    waitsForProject ? (projectName ?? "") : undefined,
  );
  const done = live?.done ?? entry.done;
  const total = live?.total ?? entry.total;
  const Icon = ICONS[entry.status];
  const button = (label: string, icon: typeof Play, run: () => void, primary = false) => {
    const Glyph = icon;
    return (
      <button
        type="button"
        className={primary ? styles.primary : styles.action}
        aria-label={`${label}：${entry.name}`}
        title={label}
        onClick={run}
      >
        <Glyph size={14} />
        <span>{label}</span>
      </button>
    );
  };
  const stopped = entry.status === "paused" || entry.status === "interrupted";
  const restoredWaiting = entry.status === "waiting" && entry.restored;
  return (
    <li className={styles.item} data-status={entry.status} aria-label={entry.name}>
      <Icon size={16} className={styles.icon} aria-hidden />
      <div className={styles.body}>
        <div className={styles.head}>
          <span className={styles.name}>{entry.name}</span>
          {elsewhere && projectName && <span className={styles.project}>{projectName}</span>}
        </div>
        {entry.status !== "done" && (
          <progress className={styles.bar} value={done} max={Math.max(total, 1)} aria-hidden />
        )}
        <div className={styles.status} role="status">
          {text}
        </div>
      </div>
      <div className={styles.actions}>
        {entry.status === "running" &&
          live &&
          !live.stopping &&
          !live.writing &&
          !live.pausing &&
          button(t("export.queue.pause"), Pause, () => videos.pause(entry.id))}
        {entry.status === "running" &&
          live?.paused &&
          !live.stopping &&
          button(t("export.window.resume"), Play, () => videos.resume(), true)}
        {entry.status === "waiting" &&
          !entry.restored &&
          button(t("export.queue.pause"), Pause, () => videos.pause(entry.id))}
        {(stopped || restoredWaiting) &&
          button(t("export.queue.goOn"), Play, () => videos.goOn(entry.id), true)}
        {entry.status === "failed" &&
          button(t("export.queue.retry"), RotateCw, () => videos.retry(entry.id), true)}
        {entry.status === "running"
          ? !live?.stopping &&
            !live?.writing &&
            button(t("export.video.cancel"), X, () => videos.cancel(entry.id))
          : button(t("export.queue.remove"), X, () => void videos.remove(entry.id))}
      </div>
    </li>
  );
}

/**
 * The exports of this window, like the downloads of a browser: what goes now, what waits for its
 * turn, and what stopped, each with what it waits for and what people can do about it.
 */
export function ExportsPanel() {
  const workbench = useWorkbench();
  const { videos } = workbench;
  const { t } = useTranslation();
  const entries = useSyncExternalStore(videos.queue.subscribe, videos.queue.getSnapshot);
  const [projects, setProjects] = useState<readonly ProjectSummary[]>();
  useEffect(() => {
    workbench.session.list().then(setProjects, () => setProjects([]));
  }, [workbench]);

  if (entries.length === 0) {
    return <div className={styles.none}>{t("export.queue.empty")}</div>;
  }
  const canGoOn = entries.some(
    ({ status, restored }) =>
      status === "paused" || status === "interrupted" || (status === "waiting" && restored),
  );
  const anyDone = entries.some(({ status }) => status === "done");
  return (
    <div className={styles.panel}>
      {(canGoOn || anyDone) && (
        <div className={styles.toolbar}>
          {canGoOn && (
            <button type="button" onClick={() => videos.goOnWithAll()}>
              {t("export.queue.goOnWithAll")}
            </button>
          )}
          {anyDone && (
            <button type="button" onClick={() => videos.clearDone()}>
              {t("export.queue.clearDone")}
            </button>
          )}
        </div>
      )}
      <ul className={styles.list} aria-label={t("export.queue.listLabel")}>
        {entries.map((entry) => (
          <Row key={entry.id} entry={entry} projects={projects} />
        ))}
      </ul>
    </div>
  );
}
