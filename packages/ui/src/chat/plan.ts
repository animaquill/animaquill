import type { ChatEntry, ToolEntry } from "@animaquill/agent";
import type { WindowMemory } from "@animaquill/host";
import { parseTime, toSeconds } from "@animaquill/schema";
import { formatAddress } from "@animaquill/tools";
import { Emitter } from "../workbench/emitter.ts";
import { linkOf } from "./refs.ts";

/**
 * The plan AI gives where people asked for one first ("先出方案", `aq_propose` kind "plan"): a card
 * whose lines people change, take out or add to, and accept ("按这个做"), which then goes as their
 * message. See docs/design/changes-and-gates.md of AnimaQuill Cloud, 3.
 */

export interface PlanStep {
  readonly text: string;
  /** Seconds on the timeline, as times of the project are written. */
  readonly from?: string;
  readonly to?: string;
}

export interface Plan {
  readonly title: string;
  readonly steps: readonly PlanStep[];
  readonly length?: string;
  readonly style?: string;
}

const isTime = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    parseTime(value);
    return true;
  } catch {
    return false;
  }
};

const stepOf = (value: unknown): PlanStep | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { text, from, to } = value as Record<string, unknown>;
  if (typeof text !== "string") return undefined;
  return { text, ...(isTime(from) && { from }), ...(isTime(to) && { to }) };
};

/** The plan of a call of `aq_propose`, as its result kept it; nothing where it gave none. */
export function planOf(entry: ToolEntry): Plan | undefined {
  if (entry.name !== "aq_propose" || !entry.ok) return undefined;
  const data = entry.data?.plan;
  if (typeof data !== "object" || data === null) return undefined;
  const { title, steps, length, style } = data as Record<string, unknown>;
  if (typeof title !== "string" || !Array.isArray(steps)) return undefined;
  return {
    title,
    steps: steps.map(stepOf).filter((step) => step !== undefined),
    ...(isTime(length) && { length }),
    ...(typeof style === "string" && style !== "" && { style }),
  };
}

/**
 * What became of each plan of a conversation, by the id of its call: the newest one waits for
 * people (`open`), unless they accepted it (`accepted`); one before a newer plan is `replaced`.
 */
export function plansIn(
  entries: readonly ChatEntry[],
): ReadonlyMap<string, "open" | "accepted" | "replaced"> {
  const plans = entries.flatMap((entry) =>
    entry.role === "tool" && planOf(entry) ? [entry.call] : [],
  );
  const accepted = new Set(
    entries.flatMap((entry) =>
      entry.role === "user" && entry.fromPlan !== undefined ? [entry.fromPlan] : [],
    ),
  );
  return new Map(
    plans.map((call, index) => [
      call,
      accepted.has(call) ? "accepted" : index === plans.length - 1 ? "open" : "replaced",
    ]),
  );
}

const two = (n: number) => String(n).padStart(2, "0");

/** A time of the project as people read a moment: 0:04, 1:02.5, 1:00:00. */
export function clockOf(time: string): string {
  const seconds = Math.max(0, toSeconds(parseTime(time)));
  const whole = Math.floor(seconds);
  const rest = Math.round((seconds - whole) * 100) / 100;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const clock = hours > 0 ? `${hours}:${two(minutes)}` : String(minutes);
  const fraction = rest > 0 ? String(rest).slice(1) : "";
  return `${clock}:${two(whole % 60)}${fraction}`;
}

/** A moment of a plan as a block of the chat (`aq:`): its clock, and the time for AI. */
export const timeRefOf = (time: string, timeline: string | undefined) => ({
  label: clockOf(time),
  href: formatAddress({ kind: "time", timeline, t: time }),
});

/** The words a plan goes with as a message, in the language of people. */
export interface PlanWords {
  /** Before the title: "按这个做：". */
  readonly accept: string;
  readonly length: string;
  readonly style: string;
}

/**
 * A plan as people's message: its title, a numbered line for each step with its times as links of
 * the editor, and its length and style. AI reads what people accepted, as they changed it.
 */
export function planMessage(plan: Plan, words: PlanWords, timeline: string | undefined): string {
  const steps = plan.steps
    .filter((step) => step.text.trim() !== "")
    .map((step, index) => {
      const times = [step.from, step.to]
        .filter((time) => time !== undefined)
        .map((time) => linkOf(timeRefOf(time, timeline)))
        .join("–");
      return `${index + 1}. ${times ? `${times} ` : ""}${step.text.trim()}`;
    });
  const end = [
    ...(plan.length !== undefined
      ? [`${words.length} ${linkOf(timeRefOf(plan.length, timeline))}`]
      : []),
    ...(plan.style !== undefined ? [`${words.style} ${plan.style}`] : []),
  ];
  return [
    `${words.accept}${plan.title}`,
    ...steps,
    ...(end.length > 0 ? [end.join(" · ")] : []),
  ].join("\n");
}

/** Where the steps of a plan as people changed them are kept in the memory of the window. */
const draftKey = (project: string, chat: string, call: string) =>
  `chat.plan\n${project}\n${chat}\n${call}`;

/**
 * The steps of plans as people changed them and did not accept yet, kept with the drafts of the
 * input box in the memory of the window: there again after a reload.
 */
export class PlanDrafts {
  readonly #memory: WindowMemory | undefined;
  readonly #known = new Map<string, readonly PlanStep[] | undefined>();
  readonly #emitter = new Emitter();

  constructor(memory: WindowMemory | undefined) {
    this.#memory = memory;
  }

  subscribe = this.#emitter.subscribe;

  /** The steps as people changed them; nothing where they did not. */
  read(project: string, chat: string, call: string): readonly PlanStep[] | undefined {
    const key = draftKey(project, chat, call);
    if (this.#known.has(key)) return this.#known.get(key);
    let steps: readonly PlanStep[] | undefined;
    try {
      const kept: unknown = JSON.parse(this.#memory?.read(key) || "null");
      steps = Array.isArray(kept)
        ? kept.map(stepOf).filter((step) => step !== undefined)
        : undefined;
    } catch {
      steps = undefined;
    }
    this.#known.set(key, steps);
    return steps;
  }

  write(project: string, chat: string, call: string, steps: readonly PlanStep[] | undefined): void {
    const key = draftKey(project, chat, call);
    this.#known.set(key, steps);
    this.#memory?.write(key, steps ? JSON.stringify(steps) : "");
    this.#emitter.emit();
  }
}
