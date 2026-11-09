import { Circle, Copy, Download, Send, Square, Trash2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { ErrorList } from "./ErrorList.tsx";
import { frameAt } from "../timeline/frames.ts";
import { FRAME_TIME_GROUPS, type DiagnosticsEvent, type DiagnosticsSnapshot } from "./recorder.ts";
import styles from "./DiagnosticsPanel.module.css";

/** Groups from here on miss the next refresh of a 60 Hz screen. */
const FIRST_SLOW_GROUP = 2;

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

function Stat({ label, value, bad }: { label: string; value: string | number; bad?: boolean }) {
  return (
    <div className={styles.stat}>
      <strong className={bad ? styles.bad : undefined}>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function Stats({ snapshot }: { snapshot: DiagnosticsSnapshot }) {
  const { t } = useTranslation();
  const { counts, framesPerSecond, memoryMb } = snapshot;
  return (
    <div className={styles.stats} role="group" aria-label={t("diagnostics.stats")}>
      <Stat label={t("diagnostics.framesPerSecond")} value={framesPerSecond} />
      <Stat
        label={t("diagnostics.slowFrames")}
        value={counts.slowFrames}
        bad={counts.slowFrames > 0}
      />
      <Stat label={t("diagnostics.cold")} value={counts.cold} bad={counts.cold > 0} />
      <Stat label={t("diagnostics.gaps")} value={counts.gaps} bad={counts.gaps > 0} />
      <Stat
        label={t("diagnostics.audioLate")}
        value={counts.audioLate}
        bad={counts.audioLate > 0}
      />
      <Stat label={t("diagnostics.errors")} value={counts.errors} bad={counts.errors > 0} />
      <Stat
        label={t("diagnostics.memory")}
        value={memoryMb === undefined ? "-" : `${memoryMb} MB`}
      />
    </div>
  );
}

function FrameTimes({ times }: { times: Readonly<Record<string, number>> }) {
  const { t } = useTranslation();
  const counts = FRAME_TIME_GROUPS.map((group) => times[group] ?? 0);
  const most = Math.max(...counts, 1);
  return (
    <section aria-label={t("diagnostics.frameTimes")}>
      <h3>{t("diagnostics.frameTimes")}</h3>
      <ul className={styles.bars}>
        {FRAME_TIME_GROUPS.map((group, index) => (
          <li key={group}>
            <span>{t(`diagnostics.group.${group}`)}</span>
            <div className={styles.track}>
              <div
                className={index >= FIRST_SLOW_GROUP ? styles.slowBar : styles.bar}
                style={{ width: `${((counts[index] ?? 0) / most) * 100}%` }}
              />
            </div>
            <span className={styles.count}>{counts[index]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function EventRow({ event }: { event: DiagnosticsEvent }) {
  const { timeline } = useWorkbench();
  const { t } = useTranslation();
  const { kind, seconds, ms, cold, message, on } = event;
  const { model } = timeline;
  const canJump = typeof seconds === "number" && model !== undefined;
  const parts = [
    typeof ms === "number" ? `${ms} ms` : undefined,
    typeof cold === "number" && cold > 0 ? t("diagnostics.coldNote") : undefined,
    typeof message === "string" ? message : undefined,
    typeof on === "boolean" ? t(on ? "diagnostics.on" : "diagnostics.off") : undefined,
  ].filter(Boolean);
  const content = (
    <>
      <span className={styles.when}>{clock(event.t)}</span>
      <span>{t(`diagnostics.kind.${kind}`, { defaultValue: kind })}</span>
      <span className={styles.detail}>{parts.join("，")}</span>
    </>
  );
  if (!canJump) return <li className={styles.event}>{content}</li>;
  return (
    <li>
      <button
        type="button"
        className={styles.event}
        title={t("diagnostics.jump")}
        onClick={() => timeline.seek(frameAt(seconds, model.rate))}
      >
        {content}
      </button>
    </li>
  );
}

function Events({ events }: { events: readonly DiagnosticsEvent[] }) {
  const { t } = useTranslation();
  return (
    <section aria-label={t("diagnostics.events")}>
      <h3>{t("diagnostics.events")}</h3>
      {events.length === 0 ? (
        <p className={styles.quiet}>{t("diagnostics.noEvents")}</p>
      ) : (
        <ul className={styles.events}>
          {events.map((event, index) => (
            <EventRow key={`${event.t}-${index}`} event={event} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Finished({ snapshot }: { snapshot: DiagnosticsSnapshot }) {
  const workbench = useWorkbench();
  const { diagnostics } = workbench;
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const { report, sentId } = snapshot;
  if (!report) return null;

  const send = () => {
    setSending(true);
    void workbench.sendDiagnostics().finally(() => setSending(false));
  };

  return (
    <section className={styles.finished}>
      {sentId === undefined ? (
        <>
          <p>{t(workbench.canSendDiagnostics ? "diagnostics.sendNote" : "diagnostics.saveNote")}</p>
          <div className={styles.actions}>
            {workbench.canSendDiagnostics && (
              <button type="button" className={styles.primary} disabled={sending} onClick={send}>
                <Send size={14} />
                {t(sending ? "diagnostics.sending" : "diagnostics.send")}
              </button>
            )}
            <button type="button" onClick={() => workbench.saveDiagnostics()}>
              <Download size={14} />
              {t("diagnostics.save")}
            </button>
            <button type="button" onClick={() => diagnostics.discard()}>
              <Trash2 size={14} />
              {t("diagnostics.discard")}
            </button>
          </div>
        </>
      ) : (
        <div className={styles.actions}>
          <span role="status">{t("diagnostics.sent", { id: sentId })}</span>
          <button type="button" onClick={() => void navigator.clipboard?.writeText(sentId)}>
            <Copy size={14} />
            {t("diagnostics.copy")}
          </button>
        </div>
      )}
      <details>
        <summary>{t("diagnostics.showReport")}</summary>
        <pre>{JSON.stringify(report, undefined, 2)}</pre>
      </details>
    </section>
  );
}

/** Starts and ends a recording, shows what it finds, and what would be sent before it is. */
export function DiagnosticsPanel() {
  const workbench = useWorkbench();
  const { diagnostics } = workbench;
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(diagnostics.subscribe, diagnostics.getSnapshot);
  const { status, elapsedMs, limitReached } = snapshot;
  const recording = status === "recording";

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        {recording ? (
          <button type="button" onClick={() => workbench.finishDiagnostics()}>
            <Square size={12} fill="currentColor" />
            {t("diagnostics.finish")}
          </button>
        ) : (
          <button type="button" className={styles.primary} onClick={() => diagnostics.start()}>
            <Circle size={12} fill="currentColor" />
            {t(status === "idle" ? "diagnostics.start" : "diagnostics.startAgain")}
          </button>
        )}
        {recording && (
          <button type="button" onClick={() => diagnostics.discard()}>
            {t("diagnostics.discard")}
          </button>
        )}
        {status !== "idle" && (
          <span className={styles.elapsed} role="timer">
            {clock(elapsedMs)}
          </span>
        )}
        {limitReached && <span className={styles.bad}>{t("diagnostics.limitReached")}</span>}
      </div>
      <div className={styles.body}>
        {status === "idle" ? (
          <p className={styles.about}>{t("diagnostics.about")}</p>
        ) : (
          <>
            {status === "finished" && <Finished snapshot={snapshot} />}
            <Stats snapshot={snapshot} />
            <div className={styles.columns}>
              <FrameTimes times={snapshot.frameTimes} />
              <Events events={snapshot.recent} />
            </div>
          </>
        )}
        <ErrorList />
      </div>
    </div>
  );
}
