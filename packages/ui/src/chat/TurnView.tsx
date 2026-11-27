import type { AttachedImage, Conversation, RunningTask, TaskOutcome } from "@animaquill/agent";
import { failureOf, promptOf } from "@animaquill/agent";
import { ChevronDown, ChevronRight, Copy, GitBranchPlus, History, RotateCcw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChatImageHeld } from "@animaquill/host";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../app/context.ts";
import { TaskApproval } from "./ApprovalCard.tsx";
import { ChangeCard } from "./ChangeCard.tsx";
import styles from "./ChatPanel.module.css";
import { useOpened } from "./expanded.ts";
import { failureText } from "./failure.ts";
import { GoBack, type GoingBack } from "./GoBack.tsx";
import { LargePicture, usePicture } from "./AttachmentsView.tsx";
import { Markdown } from "./markdown/Markdown.tsx";
import { RefChip, RefText } from "./RefChip.tsx";
import { planOf, plansIn } from "./plan.ts";
import { PlanCard } from "./PlanCard.tsx";
import { piecesOf, plainOf } from "./refs.ts";
import { summaryOf } from "./summary.ts";
import type { Names } from "./toolSummary.ts";
import type { Turn } from "./turns.ts";
import turnStyles from "./turn/turn.module.css";
import { WorkLine } from "./turn/WorkLine.tsx";
import { liveText, useLive } from "./useLive.ts";

/** A link of the editor in what AI wrote: a block, as in people's words. */
const appLink = (href: string, label: string) => <RefChip chatRef={{ href, label }} />;

/**
 * One turn of the chat (docs/design/chat-panel.md of AnimaQuill Cloud, 5): what people said; the
 * work of AI in one line, open to its steps (`WorkLine`), which says what it does while it runs;
 * the answer, the largest words of the chat, on its way while it runs; how it ended where that
 * calls for a word; and the card of what it changed.
 */
export function TurnView({
  turn,
  running,
  busy,
  conversation,
  outcome,
  latest,
  maxToolCalls,
  switches,
  names,
  modelName,
  onForked,
}: {
  readonly turn: Turn;
  readonly running: RunningTask | undefined;
  /** A task of the conversation runs, this one or another. */
  readonly busy: boolean;
  readonly conversation: Conversation;
  readonly outcome: TaskOutcome | undefined;
  /** It is the newest task, which can be tried again, go on, or have its question answered. */
  readonly latest: boolean;
  readonly maxToolCalls: number;
  /** The line before an answer that had another model pack than the one before it. */
  readonly switches: readonly string[];
  readonly names: Names;
  readonly modelName: (model: string) => string;
  /** A new conversation was copied up to this turn, its words in the input box. */
  readonly onForked: () => void;
}) {
  const shown = outcome ?? (running ? undefined : keptOutcome(turn));
  const question = latest && !running ? questionOf(turn) : undefined;
  return (
    <div
      className={styles.task}
      data-testid="chat-task"
      data-task={turn.task}
      data-running={running ? "" : undefined}
    >
      <UserView turn={turn} latest={latest} busy={busy} onForked={onForked} />
      {(running || turn.steps.length > 0 || turn.answerEntry || shown?.end === "stopped") && (
        <WorkLine
          turn={turn}
          running={running}
          conversation={conversation}
          stopped={shown?.end === "stopped"}
          names={names}
          switches={switches}
          modelName={modelName}
        />
      )}
      {running && <LiveAnswer conversation={conversation} />}
      {running && <TaskApproval task={turn.task} />}
      {turn.answer !== undefined && (
        <div className={turnStyles.answer} data-testid="chat-answer">
          <Markdown text={turn.answer} renderAppLink={appLink} />
        </div>
      )}
      {shown && (
        <OutcomeView
          outcome={shown}
          task={turn.task}
          latest={latest}
          maxToolCalls={maxToolCalls}
          changed={summaryOf(turn.entries).changes.length}
          pictures={(turn.user.images?.length ?? 0) > 0}
        />
      )}
      {question && <QuestionView question={question} />}
      <TurnPlan turn={turn} conversation={conversation} busy={busy} running={running} />
      <ChangeCard task={turn.task} entries={turn.entries} running={running !== undefined} />
    </div>
  );
}

/**
 * What people said, on the right, and what they can do with it on hovering: copy it, send the last
 * one again (asking first whether what it changed goes back), or start a new conversation from it.
 */
function UserView(props: {
  readonly turn: Turn;
  readonly latest: boolean;
  readonly busy: boolean;
  readonly onForked: () => void;
}) {
  const workbench = useWorkbench();
  const { chat, notifications } = workbench;
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [going, setGoing] = useState<GoingBack>();
  const { turn } = props;
  // What can be taken back changes with the project, and with what other windows did.
  useSyncExternalStore(workbench.undo.subscribe, workbench.undo.getSnapshot);
  const canGoBack = chat.canGoBack(turn.task);
  const changed = summaryOf(turn.entries).changes.length;
  const resend = () => {
    if (changed > 0 && chat.undoState(turn.task) === "undo") setAsking(true);
    else void chat.resend();
  };
  return (
    <div className={styles.userWrap}>
      <div className={styles.user} data-testid="chat-user">
        <RefText text={turn.user.text} />
        {turn.user.images && <SentPictures images={turn.user.images} />}
      </div>
      <SentWith turn={turn} />
      <PicturesNotSent turn={turn} latest={props.latest} />
      <div className={styles.userActions} data-testid="chat-user-actions">
        <button
          type="button"
          className={styles.icon}
          aria-label={t("chat.user.copy")}
          title={t("chat.user.copy")}
          onClick={() =>
            void navigator.clipboard
              ?.writeText(plainOf(turn.user.text))
              .then(() => notifications.push(t("chat.more.copied")))
          }
        >
          <Copy size={12} aria-hidden />
        </button>
        {props.latest && (
          <button
            type="button"
            className={styles.icon}
            aria-label={t("chat.user.resend")}
            title={t("chat.user.resend")}
            disabled={props.busy}
            onClick={resend}
          >
            <RotateCcw size={12} aria-hidden />
          </button>
        )}
        {canGoBack && (
          <button
            type="button"
            className={styles.icon}
            aria-label={t("chat.user.back")}
            title={t("chat.user.back")}
            aria-expanded={going !== undefined && !("outcome" in going)}
            disabled={props.busy}
            data-testid="chat-user-back"
            onClick={() => {
              const plan = chat.backPlan(turn.task);
              setAsking(false);
              setGoing(plan && { plan });
            }}
          >
            <History size={12} aria-hidden />
          </button>
        )}
        <button
          type="button"
          className={styles.icon}
          aria-label={t("chat.user.fork")}
          title={t("chat.user.fork")}
          disabled={props.busy}
          onClick={() => {
            chat.fork(turn.task);
            props.onForked();
          }}
        >
          <GitBranchPlus size={12} aria-hidden />
        </button>
      </div>
      {going && (
        <GoBack
          going={going}
          running={props.busy}
          onChange={setGoing}
          onClose={() => setGoing(undefined)}
        />
      )}
      {asking && (
        <div className={styles.confirm} data-testid="chat-resend-confirm">
          <p>{t("chat.user.resendAsk", { count: changed })}</p>
          <div className={styles.actions}>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                void chat.undoTask(turn.task).then(() => chat.resend());
              }}
            >
              {t("chat.user.undoThenResend")}
            </button>
            <button
              type="button"
              onClick={() => {
                setAsking(false);
                void chat.resend();
              }}
            >
              {t("chat.user.keepResend")}
            </button>
            <button type="button" onClick={() => setAsking(false)}>
              {t("chat.failure.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The answer on its way, as Markdown that parses only its last block again. */
function LiveAnswer({ conversation }: { readonly conversation: Conversation }) {
  const text = useLive(conversation.live, liveText);
  if (text === "") return null;
  return (
    <div className={turnStyles.answer} data-testid="chat-live" aria-live="polite">
      <Markdown text={text} streaming renderAppLink={appLink} />
      <span className={turnStyles.caret} aria-hidden />
    </div>
  );
}

/**
 * How an earlier task ended, as far as what was kept says: only a failure or a stop leave a mark.
 * The limit of tools does not, as its answer looks like any other.
 */
function keptOutcome(turn: Turn): TaskOutcome | undefined {
  const last = turn.entries.findLast((entry) => entry.role === "assistant");
  if (last?.role !== "assistant") return undefined;
  if (last.end === "stopped") return { task: turn.task, end: "stopped" };
  if (last.end === "failed") {
    return { task: turn.task, end: "failed", failure: failureOf(last.error ?? "") };
  }
  return undefined;
}

/**
 * How a task ended, where it calls for a word: stopped, at the limit of tools (with a way to go on),
 * cut short, or failed: what to do about it first, then what can be done right here (try again, the
 * settings, another model, the relay), what the service said folded away.
 */
function OutcomeView({
  outcome,
  task,
  latest,
  maxToolCalls,
  changed,
  pictures,
}: {
  /** The message had pictures, which the service may not have taken. */
  readonly pictures: boolean;
  readonly outcome: TaskOutcome;
  readonly task: string;
  readonly latest: boolean;
  readonly maxToolCalls: number;
  /** How many places the task changed so far, which trying again goes on from. */
  readonly changed: number;
}) {
  const workbench = useWorkbench();
  const { ai, chat } = workbench;
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  switch (outcome.end) {
    case "stopped":
      // The line of the work says so: "停了 · 做了 3 步 · 改了 2 处".
      return null;
    case "limit":
    case "length":
      return (
        <p
          className={turnStyles.outcome}
          data-testid={outcome.end === "limit" ? "chat-limit" : "chat-length"}
        >
          <span>
            {outcome.end === "limit" ? t("chat.limit", { count: maxToolCalls }) : t("chat.length")}
          </span>
          {latest && (
            <>
              {" · "}
              <button
                type="button"
                className={styles.link}
                onClick={() => void chat.send(t("chat.continueMessage"))}
              >
                {t("chat.continue")}
              </button>
            </>
          )}
        </p>
      );
    case "failed": {
      const { advice, detail } = failureText(t, outcome.failure, {
        relayed: outcome.relayed === true,
        canRelay: ai.canRelay,
      });
      const kind = outcome.failure?.kind ?? "other";
      const service = chat.modelNow()?.service;
      const settings = () =>
        workbench.openSettings({ group: "models", depth: 2, service: service?.id });
      const relay =
        kind === "network" &&
        ai.canRelay &&
        outcome.relayed !== true &&
        service !== undefined &&
        service.route !== "relay";
      const retry = () => {
        if (changed > 0 && chat.undoState(task) === "undo") setAsking(true);
        else void chat.retry();
      };
      // Too long for its model even with room made: a new conversation goes on from its summary.
      if (kind === "contextFull")
        return (
          <div className={styles.failure} role="alert" data-testid="chat-failure" data-kind={kind}>
            <p>
              {advice}
              {latest && (
                <button
                  type="button"
                  className={styles.link}
                  data-testid="chat-fresh"
                  onClick={() => chat.continueFresh()}
                >
                  {t("chat.failure.fresh")}
                </button>
              )}
            </p>
            {detail && (
              <details className={styles.raw}>
                <summary>{t("chat.failure.details")}</summary>
                <p className={styles.muted}>{detail}</p>
              </details>
            )}
          </div>
        );
      return (
        <div className={styles.failure} role="alert" data-testid="chat-failure">
          <p>{advice}</p>
          {latest && (
            <div className={styles.actions}>
              {(kind === "key" || kind === "notFound") && (
                <button type="button" className={styles.primary} onClick={settings}>
                  {t("chat.failure.settings")}
                </button>
              )}
              {relay && (
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => {
                    ai.update(service.id, { route: "relay" });
                    void chat.retry();
                  }}
                >
                  {t("chat.failure.useRelay")}
                </button>
              )}
              <button type="button" onClick={retry}>
                {t("chat.failure.retry")}
              </button>
              {pictures && (
                <button
                  type="button"
                  data-testid="chat-resend-without-pictures"
                  onClick={() => void chat.resendWithoutPictures()}
                >
                  {t("chat.failure.withoutPictures")}
                </button>
              )}
              {kind !== "network" && (
                <button
                  type="button"
                  onClick={() => workbench.openSettings({ group: "models", depth: 1 })}
                >
                  {t("chat.failure.otherModel")}
                </button>
              )}
            </div>
          )}
          {asking && (
            <div className={styles.confirm} data-testid="chat-retry-confirm">
              <p>{t("chat.failure.retryChanged", { count: changed })}</p>
              <div className={styles.actions}>
                <button
                  type="button"
                  onClick={() => {
                    setAsking(false);
                    void chat.undoTask(task).then(() => chat.retry());
                  }}
                >
                  {t("chat.failure.undoThenRetry")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAsking(false);
                    void chat.retry();
                  }}
                >
                  {t("chat.failure.retryOn")}
                </button>
                <button type="button" onClick={() => setAsking(false)}>
                  {t("chat.failure.cancel")}
                </button>
              </div>
            </div>
          )}
          {detail && (
            <details className={styles.raw}>
              <summary>{t("chat.failure.details")}</summary>
              <p className={styles.muted}>{detail}</p>
            </details>
          )}
        </div>
      );
    }
    default:
      return null;
  }
}

/** The plan of a turn, where AI gave one (`aq_propose` kind "plan"), see `PlanCard`. */
function TurnPlan(props: {
  readonly turn: Turn;
  readonly conversation: Conversation;
  readonly busy: boolean;
  readonly running: RunningTask | undefined;
}) {
  const { turn } = props;
  const given = turn.entries.findLast(
    (entry) => entry.role === "tool" && planOf(entry) !== undefined,
  );
  if (given?.role !== "tool" || props.running) return null;
  const plan = planOf(given);
  const state = plansIn(props.conversation.getSnapshot().entries).get(given.call);
  if (!plan || !state) return null;
  return (
    <PlanCard
      call={given.call}
      plan={plan}
      state={state}
      timeline={turn.user.selection?.timeline}
      busy={props.busy}
    />
  );
}

/** A question AI asked with aq_propose, which the newest task can still have answered. */
interface Question {
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly detail?: string }[];
  readonly other: boolean;
}

function questionOf(turn: Turn): Question | undefined {
  const asked = turn.entries.findLast(
    (entry) => entry.role === "tool" && entry.name === "aq_propose" && entry.ok,
  );
  const data = asked?.role === "tool" ? asked.data?.question : undefined;
  if (typeof data !== "object" || data === null) return undefined;
  const { question, options, allow_other: other } = data as Record<string, unknown>;
  if (typeof question !== "string" || !Array.isArray(options)) return undefined;
  const choices = options.flatMap((option: Record<string, unknown>) =>
    typeof option?.label === "string"
      ? [
          {
            label: option.label,
            ...(typeof option.detail === "string" && { detail: option.detail }),
          },
        ]
      : [],
  );
  return { question, options: choices, other: other !== false };
}

/** The question of AI, with its answers to pick: the pick goes as the next message. */
function QuestionView({ question }: { readonly question: Question }) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  return (
    <div className={styles.question} data-testid="chat-question" role="group">
      <div className={styles.muted}>{t("chat.question.title")}</div>
      <p className={styles.text}>{question.question}</p>
      <div className={styles.options}>
        {question.options.map(({ label, detail }) => (
          <button key={label} type="button" title={detail} onClick={() => void chat.send(label)}>
            {label}
            {detail && <span className={styles.muted}> · {detail}</span>}
          </button>
        ))}
      </div>
      {question.other && <p className={styles.muted}>{t("chat.question.other")}</p>}
    </div>
  );
}

/**
 * What went with people's words, over them on the right: the frames and pictures, and the line
 * "附带" opens to show what AI got as it was (links and the lines of the pictures), to copy.
 */
function SentWith({ turn }: { readonly turn: Turn }) {
  const { notifications } = useWorkbench();
  const { t } = useTranslation();
  const [open, setOpen] = useOpened(`${turn.task}/sent`, false);
  const images = turn.user.images ?? [];
  const refs = piecesOf(turn.user.text).filter((piece) => "ref" in piece).length;
  if (images.length === 0 && refs === 0) return null;
  const sent = promptOf(turn.user);
  return (
    <div className={styles.sentWith} data-testid="chat-sent-with">
      <button
        type="button"
        className={styles.sentWithHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t("chat.attached.title")}
        {images.map((image, index) => (
          <span key={`${image.image}/${index}`} className={styles.sentTag}>
            {image.label ?? t("chat.attached.picture", { number: index + 1 })}
          </span>
        ))}
        {refs > 0 && (
          <span className={styles.sentTag}>{t("chat.attached.refs", { count: refs })}</span>
        )}
        {open ? <ChevronDown size={11} aria-hidden /> : <ChevronRight size={11} aria-hidden />}
      </button>
      {open && (
        <div className={styles.sentBody} data-testid="chat-sent">
          <div className={styles.sentBodyHead}>
            <span>{t("chat.attached.sent")}</span>
            <button
              type="button"
              className={styles.link}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(sent)
                  .then(() => notifications.push(t("chat.more.copied")))
              }
            >
              {t("chat.attached.copy")}
            </button>
          </div>
          <pre data-testid="chat-sent-text">{sent}</pre>
        </div>
      )}
    </div>
  );
}

/** The pictures of a message, small; a click shows one large. */
function SentPictures({ images }: { readonly images: readonly AttachedImage[] }) {
  const { chatSync } = useWorkbench();
  const { t } = useTranslation();
  const [large, setLarge] = useState<{ url: string; label: string } | undefined>();
  /** Which pictures show, by their hash, as each was read. */
  const [shown, setShown] = useState<ReadonlyMap<string, boolean>>(new Map());
  // As this window finds pictures that stayed here.
  useSyncExternalStore(chatSync?.subscribe ?? noSubscribe, chatSync?.getSnapshot ?? noSnapshot);
  // Each picture that stayed on one device as the conversation went to the account: here, where it
  // shows, else on another one.
  const held = new Map<string, { why: ChatImageHeld; here: boolean }>();
  for (const image of images) {
    const why = chatSync?.heldOf(image.image) ?? image.held;
    const showing = shown.get(image.image);
    if (why === undefined || showing === undefined) continue;
    held.set(image.image, { why, here: showing });
  }
  const lines = new Map<string, number>();
  for (const { why, here } of held.values()) {
    const key = `${here ? "here" : "there"}/${why}`;
    lines.set(key, (lines.get(key) ?? 0) + 1);
  }
  return (
    <>
      <span className={styles.sentPictures}>
        {images.map((image, index) => (
          <SentPicture
            key={`${image.image}/${index}`}
            image={image}
            held={held.has(image.image) && !held.get(image.image)!.here}
            fromAccount={chatSync !== undefined}
            onShown={(showing) =>
              setShown((before) =>
                before.get(image.image) === showing
                  ? before
                  : new Map(before).set(image.image, showing),
              )
            }
            onOpen={(url, label) => setLarge({ url, label })}
          />
        ))}
        {large && <LargePicture {...large} onClose={() => setLarge(undefined)} />}
      </span>
      {[...lines].map(([key, count]) => {
        const [where, why] = key.split("/") as ["here" | "there", ChatImageHeld];
        return (
          <p key={key} className={styles.muted} data-testid="chat-picture-held" data-held={why}>
            {t(`chat.pictures.held.${where}.${images.length === 1 ? "one" : "some"}`, {
              count,
              why: t(`chat.pictures.heldWhy.${why}`),
            })}
          </p>
        );
      })}
    </>
  );
}

const noSubscribe = () => () => {};
const noSnapshot = () => undefined;

function SentPicture(props: {
  readonly image: AttachedImage;
  /** It stayed on another device: there is nothing to try again. */
  readonly held: boolean;
  /** Pictures not here can come from the account, which may fail and be tried again. */
  readonly fromAccount: boolean;
  readonly onShown: (showing: boolean) => void;
  readonly onOpen: (url: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const { url, reading } = usePicture(props.image.image, attempt);
  const { onShown } = props;
  useEffect(() => {
    if (!reading) onShown(url !== undefined);
  }, [reading, url, onShown]);
  const label = props.image.label ?? "";
  if (!url && !reading && !props.held && props.fromAccount)
    return (
      <span className={styles.sentPicture} data-testid="chat-sent-picture" data-state="unreadable">
        <span>{t("chat.pictures.fetchFailed")}</span>
        <button
          type="button"
          className={styles.pictureRetry}
          data-testid="chat-picture-retry"
          onClick={() => setAttempt((count) => count + 1)}
        >
          {t("chat.pictures.retryRead")}
        </button>
      </span>
    );
  return (
    <button
      type="button"
      className={styles.sentPicture}
      data-testid="chat-sent-picture"
      data-state={url ? "shown" : reading ? "reading" : "elsewhere"}
      title={label}
      disabled={!url}
      onClick={() => url && props.onOpen(url, label)}
    >
      {url ? (
        <img src={url} alt={label} />
      ) : (
        <span>{reading ? t("chat.pictures.reading") : t("chat.pictures.missing")}</span>
      )}
    </button>
  );
}

/**
 * Pictures of an earlier turn do not go to a model that takes none, which the conversation uses
 * now: the turn says so.
 */
function PicturesNotSent({ turn }: { readonly turn: Turn; readonly latest: boolean }) {
  const { chat, ai } = useWorkbench();
  const { t } = useTranslation();
  useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  if (!turn.user.images?.length || chat.seesPictures() !== false) return null;
  const now = chat.modelNow();
  const name = (now && ai.modelOf(now.ref.service, now.ref.model)?.name) ?? now?.ref.model ?? "";
  return (
    <p className={styles.muted} data-testid="chat-pictures-not-sent">
      {t("chat.pictures.notSent", { model: name, interpolation: { escapeValue: false } })}
    </p>
  );
}
