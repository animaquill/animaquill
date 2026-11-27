import type { Conversation, ConversationSnapshot } from "@animaquill/agent";
import { LoaderCircle, Square } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useNow } from "../chat/clock.ts";
import { namesIn } from "../chat/names.ts";
import type { RunSummary } from "../chat/session.ts";
import { placesOf, summaryOf } from "../chat/summary.ts";
import type { Say } from "../chat/toolSummary.ts";
import { livePhase, useLive } from "../chat/useLive.ts";
import { phaseOf } from "../chat/turn/work.ts";
import { duration } from "../export/window.ts";
import { useProject, useSession, useWorkbench } from "./context.ts";
import { Bubble } from "./Bubble.tsx";
import styles from "./ChatRunsStatus.module.css";
import { Tip } from "./Tip.tsx";

const noop = () => () => {};
const NOTHING: ConversationSnapshot = { entries: [], running: undefined, last: undefined };

/**
 * The conversations of the chat whose tasks run, also those it does not show
 * (docs/design/ai-teamwork.md of AnimaQuill Cloud, 1): "「剪开场」在跑", or how many run; a press
 * lists them, each with what it does now and for how long, to go to it or stop it, and all of them
 * stop at once from there.
 */
export function ChatRunsStatus() {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const runs = useSyncExternalStore(chat.subscribe, () => chat.getSnapshot().runs);
  const running = runs.filter((run) => run.state !== "idle" && run.startedAt !== undefined);
  const [anchor, setAnchor] = useState<DOMRect>();
  if (running.length === 0) return null;
  // A task that waits for people to allow a change is still a task: it says so, without a spinner.
  const going = running.filter((run) => run.state === "running");
  const waiting = running.filter((run) => run.state === "waiting");
  const name = (run: RunSummary | undefined) => run?.title || t("chat.untitled");
  const plain = { interpolation: { escapeValue: false } };
  const goingText =
    going.length === 1
      ? t("chat.runs.one", { title: name(going[0]), ...plain })
      : t("chat.runs.many", { count: going.length });
  const text =
    going.length === 0
      ? waiting.length === 1
        ? t("chat.runs.waitsOne", { title: name(waiting[0]), ...plain })
        : t("chat.runs.waitsMany", { count: waiting.length })
      : waiting.length === 0
        ? goingText
        : `${goingText} · ${t("chat.runs.andWaiting", { count: waiting.length })}`;
  return (
    <>
      <Tip name={t("chat.runs.title")} usage={t("chat.runs.usage")}>
        <button
          type="button"
          className={styles.status}
          aria-haspopup="dialog"
          data-testid="status-runs"
          onClick={(event) => setAnchor(event.currentTarget.getBoundingClientRect())}
        >
          {going.length > 0 ? (
            <LoaderCircle size={12} className={styles.spin} aria-hidden />
          ) : (
            <span className={styles.dot} aria-hidden />
          )}
          <span className={styles.text}>{text}</span>
        </button>
      </Tip>
      {anchor && (
        <Bubble anchor={anchor} title={t("chat.runs.title")} onClose={() => setAnchor(undefined)}>
          <div className={styles.list} data-testid="status-runs-list">
            {running.map((run) => (
              <RunRow key={run.id} run={run} onGo={() => setAnchor(undefined)} />
            ))}
            <button
              type="button"
              className={styles.stopAll}
              data-testid="status-runs-stop-all"
              onClick={() => {
                chat.stopAll();
                setAnchor(undefined);
              }}
            >
              {t("chat.runs.stopAll")}
            </button>
          </div>
        </Bubble>
      )}
    </>
  );
}

/** One conversation whose task runs: its name, what it does now, for how long, and stop. */
function RunRow(props: { readonly run: RunSummary; readonly onGo: () => void }) {
  const { chat, looks, layout } = useWorkbench();
  const { t } = useTranslation();
  const say = t as unknown as Say;
  const { store } = useSession();
  const state = useProject(store);
  const names = useMemo(() => namesIn(state), [state]);
  const { run } = props;
  const conversation: Conversation | undefined = chat.conversationOf(run.id);
  const talk = useSyncExternalStore(
    conversation?.subscribe ?? noop,
    conversation?.getSnapshot ?? (() => NOTHING),
  );
  const live = useLive(conversation?.live, livePhase);
  const look = useSyncExternalStore(looks.subscribe, looks.getSnapshot);
  const { allApprovals } = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const now = useNow(true);
  const pending = allApprovals.filter((each) => each.chat === run.id);
  const doing = talk.running
    ? phaseOf(say, {
        running: talk.running,
        live,
        heardAt: conversation?.live.getState().heardAt ?? 0,
        look,
        approving:
          pending.length > 0
            ? placesOf(
                summaryOf([
                  {
                    role: "tool",
                    call: run.id,
                    name: "aq_edit",
                    ok: true,
                    text: "",
                    at: 0,
                    data: { changes: pending.flatMap((each) => each.request.changes) },
                  },
                ]),
              )
            : undefined,
        now,
        names,
      }).text
    : "";
  const title = run.title || t("chat.untitled");
  return (
    <div className={styles.row} data-testid="status-run" data-id={run.id}>
      <button
        type="button"
        className={styles.go}
        onClick={() => {
          layout.openPanel("chat");
          void chat.open(run.id);
          props.onGo();
        }}
      >
        <span className={styles.title}>{title}</span>
        <span className={styles.doing}>
          {doing}
          {run.startedAt !== undefined && ` · ${duration(Math.max(0, now - run.startedAt))}`}
        </span>
      </button>
      <Tip name={t("chat.runs.stop")} usage="">
        <button
          type="button"
          className={styles.stop}
          aria-label={t("chat.runs.stopOne", { title, interpolation: { escapeValue: false } })}
          data-testid="status-run-stop"
          onClick={() => chat.stop(run.id)}
        >
          <Square size={10} aria-hidden />
        </button>
      </Tip>
    </div>
  );
}
