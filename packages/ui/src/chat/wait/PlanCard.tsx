import { ChevronRight, ListChecks, Pencil, Plus, X } from "lucide-react";
import { useCallback, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWorkbench } from "../../app/context.ts";
import { useOpened } from "../expanded.ts";
import { planMessage, timeRefOf, type Plan, type PlanStep } from "../plan.ts";
import { RefChip } from "../RefChip.tsx";
import { WaitCard } from "./WaitCard.tsx";
import styles from "./wait.module.css";

/**
 * The plan AI gave where people asked for one first (docs/design/chat-panel.md of AnimaQuill Cloud,
 * 6.3): its title, a numbered line for each step with its times as blocks of the editor, and its
 * length and style. The plan that waits for people is a card that waits: a step shows it can be
 * clicked to change it, its pencil and × on hovering, "加一步" adds one, and "按这个做" (Enter on the
 * card) sends it as their message. One accepted, or one a newer plan replaced, is one line, open to
 * read.
 */
export function PlanCard(props: {
  /** The call of `aq_propose` that gave it. */
  readonly call: string;
  readonly plan: Plan;
  readonly state: "open" | "accepted" | "replaced";
  /** The timeline the times are on: the one people were on as they asked for it. */
  readonly timeline: string | undefined;
  /** A task of the conversation runs: nothing goes meanwhile. */
  readonly busy: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useOpened(`${props.call}/plan`, false);
  if (props.state === "open") return <OpenPlan {...props} />;
  return (
    <div className={styles.done} data-testid="chat-plan" data-state={props.state}>
      <button
        type="button"
        className={styles.doneHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ListChecks size={12} aria-hidden />
        <span className={styles.doneTitle}>
          {t("chat.plan.title", { title: props.plan.title, interpolation: { escapeValue: false } })}
          {" · "}
          {t(props.state === "accepted" ? "chat.plan.accepted" : "chat.plan.replaced")}
        </span>
        <ChevronRight size={12} aria-hidden className={styles.doneChevron} />
      </button>
      {open && (
        <>
          <ol className={styles.steps}>
            {props.plan.steps.map((step, index) => (
              <li key={index} className={styles.step}>
                <span className={styles.number}>{index + 1}</span>
                <span className={styles.stepMain}>
                  <Times step={step} timeline={props.timeline} />
                  <span className={styles.text}>{step.text}</span>
                </span>
              </li>
            ))}
          </ol>
          <PlanEnd plan={props.plan} timeline={props.timeline} />
        </>
      )}
    </div>
  );
}

function Times({
  step,
  timeline,
}: {
  readonly step: PlanStep;
  readonly timeline: string | undefined;
}) {
  if (step.from === undefined && step.to === undefined) return null;
  return (
    <span className={styles.times}>
      {step.from !== undefined && <RefChip chatRef={timeRefOf(step.from, timeline)} />}
      {step.from !== undefined && step.to !== undefined && "–"}
      {step.to !== undefined && <RefChip chatRef={timeRefOf(step.to, timeline)} />}
    </span>
  );
}

function PlanEnd({
  plan,
  timeline,
}: {
  readonly plan: Plan;
  readonly timeline: string | undefined;
}) {
  const { t } = useTranslation();
  if (plan.length === undefined && plan.style === undefined) return null;
  return (
    <p className={styles.footText} data-testid="chat-plan-end">
      {plan.length !== undefined && (
        <>
          {t("chat.plan.length")} <RefChip chatRef={timeRefOf(plan.length, timeline)} />
        </>
      )}
      {plan.length !== undefined && plan.style !== undefined && " · "}
      {plan.style !== undefined && `${t("chat.plan.style")} ${plan.style}`}
    </p>
  );
}

/** The plan that waits for people: its lines to change, and "按这个做". */
function OpenPlan(props: {
  readonly call: string;
  readonly plan: Plan;
  readonly timeline: string | undefined;
  readonly busy: boolean;
}) {
  const { chat } = useWorkbench();
  const { t } = useTranslation();
  const project = chat.projectKey;
  const id = chat.getSnapshot().id;
  const read = useCallback(
    () =>
      project === undefined || id === undefined
        ? undefined
        : chat.planDrafts.read(project, id, props.call),
    [chat, project, id, props.call],
  );
  const changed = useSyncExternalStore(chat.planDrafts.subscribe, read);
  const steps = changed ?? props.plan.steps;
  /** The line being changed, by its place, and what it says meanwhile. */
  const [editing, setEditing] = useState<{ readonly index: number; readonly text: string }>();
  const write = (next: readonly PlanStep[]) => {
    if (project !== undefined && id !== undefined)
      chat.planDrafts.write(project, id, props.call, next);
  };
  const commit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    setEditing(undefined);
    if (text === "") write(steps.filter((_, index) => index !== editing.index));
    else if (text !== steps[editing.index]?.text)
      write(steps.map((step, index) => (index === editing.index ? { ...step, text } : step)));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // A line just added and left empty goes again.
      if (editing && steps[editing.index]?.text === "")
        write(steps.filter((_, index) => index !== editing.index));
      setEditing(undefined);
    }
  };
  // A line being changed goes as it says now.
  const final = steps.map((step, index) =>
    editing?.index === index ? { ...step, text: editing.text } : step,
  );
  const left = final.filter((step) => step.text.trim() !== "");
  const accept = () =>
    void chat.acceptPlan(
      props.call,
      planMessage(
        { ...props.plan, steps: left },
        {
          accept: t("chat.plan.message"),
          length: t("chat.plan.length"),
          style: t("chat.plan.style"),
        },
        props.timeline,
      ),
    );
  return (
    <WaitCard
      kind="plan"
      icon={<ListChecks size={13} aria-hidden />}
      title={t("chat.plan.title", {
        title: props.plan.title,
        interpolation: { escapeValue: false },
      })}
      testId="chat-plan"
      state="open"
      foot={<PlanEnd plan={props.plan} timeline={props.timeline} />}
      actions={[
        {
          id: "chat-plan-accept",
          label: t("chat.plan.accept"),
          primary: true,
          keys: "Enter",
          disabled: props.busy || left.length === 0,
          onAct: accept,
        },
      ]}
    >
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li key={index} className={styles.step} data-testid="chat-plan-step">
            <span className={styles.number}>{index + 1}</span>
            <span className={styles.stepMain}>
              <Times step={step} timeline={props.timeline} />
              {editing?.index === index ? (
                <input
                  className={styles.input}
                  aria-label={t("chat.plan.edit")}
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- people just clicked the line
                  autoFocus
                  maxLength={300}
                  value={editing.text}
                  onChange={(event) => setEditing({ index, text: event.target.value })}
                  onKeyDown={onKeyDown}
                  onBlur={commit}
                />
              ) : (
                <button
                  type="button"
                  className={styles.text}
                  title={t("chat.plan.edit")}
                  onClick={() => {
                    commit();
                    setEditing({ index, text: step.text });
                  }}
                >
                  {step.text}
                </button>
              )}
            </span>
            {editing?.index !== index && (
              <button
                type="button"
                className={styles.stepButton}
                aria-label={t("chat.plan.edit")}
                title={t("chat.plan.edit")}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  commit();
                  setEditing({ index, text: step.text });
                }}
              >
                <Pencil size={12} aria-hidden />
              </button>
            )}
            <button
              type="button"
              className={styles.stepButton}
              aria-label={t("chat.plan.remove")}
              title={t("chat.plan.remove")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setEditing(undefined);
                write(steps.filter((_, at) => at !== index));
              }}
            >
              <X size={12} aria-hidden />
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className={styles.add}
        data-testid="chat-plan-add"
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          commit();
          const next = [...steps, { text: "" }];
          write(next);
          setEditing({ index: next.length - 1, text: "" });
        }}
      >
        <Plus size={12} aria-hidden />
        {t("chat.plan.add")}
      </button>
    </WaitCard>
  );
}
