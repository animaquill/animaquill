import type { RunningTask } from "@animaquill/agent";
import type { LookPhase } from "../../look/looks.ts";
import { isHeld, type Names, type Say } from "../toolSummary.ts";
import { durationText, type Step } from "../turns.ts";

/**
 * The line of the work of a turn (docs/design/chat-panel.md of AnimaQuill Cloud, 5.2): while the
 * turn runs, what it does now in words people read, with how long; once done, how long it took,
 * how many steps, how many places it changed and what it cost.
 */

/** How long without a word from the service before the line says it went quiet. */
export const QUIET_MS = 60_000;

/** The tool whose pictures show in the chat. */
export const LOOK_TOOL = "aq_render_frames";
/** The tool whose level of the sound shows in the chat. */
export const LISTEN_TOOL = "aq_audio_analyze";

/** The status code a failure has in its words, such as 429. */
const codeIn = (message: string) => /\b(429|5\d\d)\b/.exec(message)?.[1];

/** What a running turn says of itself, and how. */
export interface Phase {
  readonly kind:
    | "compacting"
    | "retry"
    | "approve"
    | "look"
    | "lookWaits"
    | "tool"
    | "waiting"
    | "thinking"
    | "writing"
    | "quiet";
  readonly text: string;
  /** What comes after the words and is never cut short where the line is narrow: a countdown. */
  readonly tail?: string;
  /**
   * What those who listen hear of it: the words without what changes each second, said once as
   * the kind of state changes.
   */
  readonly said: string;
  /** Yellow where the task waits on something people may want to know of, blue where on them. */
  readonly tone: "normal" | "warn" | "accent";
}

export interface PhaseInput {
  readonly running: RunningTask;
  /** What the model does, by its words on their way. */
  readonly live: "waiting" | "thinking" | "writing";
  /** When anything last came, or people said to wait on. */
  readonly heardAt: number;
  readonly look: LookPhase;
  /** How many places a change that waits for people's answer would change, where one waits. */
  readonly approving: number | undefined;
  readonly now: number;
  readonly names: Names;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fields an operation names its object by, in the order to look. */
const OBJECT_KEYS = ["clip", "id", "track", "marker", "section", "scene", "sound", "asset"];

/** What an edit works on, by the name the project has for its first object. */
function editedName(args: Readonly<Record<string, unknown>>, names: Names): string | undefined {
  const operations = Array.isArray(args.operations) ? args.operations : [];
  const timeline = typeof args.timeline === "string" ? args.timeline : undefined;
  for (const operation of operations) {
    if (!isRecord(operation)) continue;
    for (const key of OBJECT_KEYS) {
      const id = operation[key];
      if (typeof id !== "string") continue;
      const name = names.object(id, timeline);
      if (name) return name;
    }
  }
  return undefined;
}

/**
 * What a running turn does now, in one line: summing up the earlier conversation, waiting to try
 * again after a busy service, waiting for people to allow a change, looking at frames (or waiting
 * for people to stop playing, to export, to come back), running a tool, or the model waited on,
 * thinking, writing; quiet for a minute where nothing comes and no tool runs.
 */
export function phaseOf(say: Say, input: PhaseInput): Phase {
  const { running, look, now } = input;
  const { tool, retry } = running;
  if (running.compacting) {
    const text = say("chat.phase.compacting");
    return { kind: "compacting", text, said: text, tone: "normal" };
  }
  if (retry) {
    const code = codeIn(retry.failure.message);
    const reason = say(`chat.retryReason.${retry.failure.kind}`);
    return {
      kind: "retry",
      text: say("chat.phase.retry", {
        reason: code ? `${reason}（${code}）` : reason,
        attempt: retry.attempt,
        of: retry.of,
      }),
      tail: say("chat.phase.retryIn", { seconds: Math.max(0, Math.ceil((retry.at - now) / 1000)) }),
      said: say("chat.phase.retrySaid", { reason }),
      tone: "warn",
    };
  }
  if (input.approving !== undefined) {
    const text = say("chat.phase.approve", { count: input.approving });
    return { kind: "approve", text, said: text, tone: "accent" };
  }
  if (tool?.name === LOOK_TOOL) {
    if (look.kind === "rendering") {
      return {
        kind: "look",
        text: say("chat.phase.look.rendering", {
          done: Math.min(look.done + 1, look.total),
          total: look.total,
        }),
        said: say("chat.phase.look.start"),
        tone: "normal",
      };
    }
    if (look.kind !== "idle") {
      const text = say(`chat.phase.look.${look.kind}`);
      return { kind: "lookWaits", text, said: text, tone: "warn" };
    }
    const text = say("chat.phase.look.start");
    return { kind: "look", text, said: text, tone: "normal" };
  }
  if (tool) {
    const name = say(`chat.tool.${tool.name}`, { defaultValue: tool.name });
    const operations = Array.isArray(tool.args.operations) ? tool.args.operations.length : 0;
    const edited = tool.name === "aq_edit" ? editedName(tool.args, input.names) : undefined;
    const text = edited
      ? operations > 1
        ? say("chat.phase.editNamedMore", { name: edited, count: operations })
        : say("chat.phase.editNamed", { name: edited })
      : tool.name === "aq_edit" && operations > 0
        ? say("chat.phase.toolOps", { name, count: operations })
        : say("chat.phase.tool", { name });
    return { kind: "tool", text, said: text, tone: "normal" };
  }
  if (input.heardAt > 0 && now - input.heardAt >= QUIET_MS) {
    return {
      kind: "quiet",
      text: say("chat.phase.quiet", { seconds: Math.floor((now - input.heardAt) / 1000) }),
      said: say("chat.phase.quietSaid"),
      tone: "warn",
    };
  }
  // The model at work: not said aloud, each turn has it between every two steps.
  const text = say(`chat.phase.${input.live}`);
  return { kind: input.live, text, said: "", tone: "normal" };
}

/** The calls that failed and were not done right by a later call of the same tool. */
export function finalFailures(steps: readonly Step[]): number {
  let count = 0;
  steps.forEach((step, at) => {
    if (step.kind !== "tool" || !step.result || step.result.ok || isHeld(step.result)) return;
    const later = steps
      .slice(at + 1)
      .some(
        (other) =>
          other.kind === "tool" && other.call.name === step.call.name && other.result?.ok === true,
      );
    if (!later) count += 1;
  });
  return count;
}

/** What a turn that is over says of its work, in parts of one line. */
export interface WorkDone {
  /** "想了 8 秒", where its length is known. */
  readonly time: string | undefined;
  /** "做了 5 步", where it called tools. */
  readonly steps: string | undefined;
  /** "改了 3 处", where it changed the project. */
  readonly changed: string | undefined;
  /** "1 步没成", where calls failed for good. */
  readonly failed: string | undefined;
}

export function workDone(
  say: Say,
  turn: {
    readonly ms: number | undefined;
    readonly tools: number;
    readonly steps: readonly Step[];
  },
  places: number,
  stopped: boolean,
): WorkDone {
  const failed = finalFailures(turn.steps);
  return {
    time:
      stopped || turn.ms === undefined
        ? undefined
        : say("chat.work.thought", { time: durationText(say, turn.ms, true) }),
    steps: turn.tools > 0 ? say("chat.work.steps", { count: turn.tools }) : undefined,
    changed: places > 0 ? say("chat.work.changed", { count: places }) : undefined,
    failed: failed > 0 ? say("chat.work.failed", { count: failed }) : undefined,
  };
}

/** How long a line of a running turn stays at least, so that quick steps do not flicker by. */
export const STEADY_MS = 500;

/**
 * Which phase a line holds for a moment (`STEADY_MS`) before the next one shows: a countdown or the
 * frame rendered are still the same one, and change at once.
 */
export const phaseKey = (phase: Phase): string =>
  phase.kind === "retry" || phase.kind === "quiet" || phase.kind === "look"
    ? phase.kind
    : `${phase.kind}\n${phase.text}`;
