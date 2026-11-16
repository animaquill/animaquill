import {
  entryOf,
  objectKey,
  type ProblemSeverity,
  type ProjectProblem,
  type ProjectState,
} from "@animaquill/core";
import { Time, compare, parseTime } from "@animaquill/schema";
import { z } from "zod";
import { answer, failed } from "../context.ts";
import { offsetOf, paged } from "../page.ts";
import { problemLines } from "../problems-en.ts";
import { PARAM } from "../texts/index.ts";
import type { ToolDefinition } from "../tool.ts";
import type { ToolResult } from "../types.ts";

/** How many steps a plan has at most. */
export const MOST_PLAN_STEPS = 20;

const PlanStep = z.strictObject({
  text: z.string().min(1).max(300).describe(PARAM),
  from: Time.optional().describe(PARAM),
  to: Time.optional().describe(PARAM),
});

// One object for every kind, not a union of them: some services take no union at the top of a
// schema. Which fields go with which kind is checked in `check`.
const ProposeParams = z.strictObject({
  kind: z.enum(["question", "plan"]).describe(PARAM),
  question: z.string().min(1).max(300).optional().describe(PARAM),
  options: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(80).describe(PARAM),
        detail: z.string().max(200).optional().describe(PARAM),
      }),
    )
    .min(2)
    .max(6)
    .optional()
    .describe(PARAM),
  allow_other: z.boolean().optional().describe(PARAM),
  title: z.string().min(1).max(80).optional().describe(PARAM),
  steps: z.array(PlanStep).min(1).max(MOST_PLAN_STEPS).optional().describe(PARAM),
  length: Time.optional().describe(PARAM),
  style: z.string().max(200).optional().describe(PARAM),
});

type ProposeArgs = z.output<typeof ProposeParams>;

/** The fields of each kind: those it needs, and those it may have. */
const FIELDS = {
  question: { needs: ["question", "options"], may: ["allow_other"] },
  plan: { needs: ["title", "steps"], may: ["length", "style"] },
} as const;

/** A question to the user, as the chat shows it (`data.question`). */
export interface ProposedQuestion {
  readonly kind: "question";
  readonly question: string;
  readonly options: readonly { readonly label: string; readonly detail?: string }[];
  readonly allow_other?: boolean;
}

/** A plan for the user to change or accept before anything changes (`data.plan`). */
export interface ProposedPlan {
  readonly kind: "plan";
  readonly title: string;
  readonly steps: readonly {
    readonly text: string;
    readonly from?: string;
    readonly to?: string;
  }[];
  readonly length?: string;
  readonly style?: string;
}

function checkPropose(args: ProposeArgs): ToolResult | undefined {
  const lines: string[] = [];
  const given = (field: string) => (args as Record<string, unknown>)[field] !== undefined;
  for (const field of FIELDS[args.kind].needs) {
    if (!given(field)) lines.push(`${field}: required with kind "${args.kind}"`);
  }
  for (const [kind, fields] of Object.entries(FIELDS)) {
    if (kind === args.kind) continue;
    for (const field of [...fields.needs, ...fields.may]) {
      if (given(field)) lines.push(`${field}: goes only with kind "${kind}"`);
    }
  }
  if (args.kind === "plan") {
    for (const [index, step] of (args.steps ?? []).entries()) {
      if (step.from !== undefined && step.to !== undefined) {
        if (compare(parseTime(step.from), parseTime(step.to)) > 0)
          lines.push(`steps.${index}: from has to be before to`);
      }
    }
  }
  return lines.length === 0
    ? undefined
    : failed(
        ["error invalid-params", ...lines.map((line) => `  ${line}`), "nothing was shown"].join(
          "\n",
        ),
      );
}

export const propose: ToolDefinition<ProposeArgs> = {
  name: "aq_propose",
  title: "Ask the user",
  params: ProposeParams,
  check: checkPropose,
  run: (call, args) => {
    const { caller } = call;
    if (caller.answer.proposed) {
      return failed(
        "error one-at-a-time: this answer already hands the user a question or a plan; one per answer.",
      );
    }
    caller.hold("asked");
    if (args.kind === "plan") {
      const plan: ProposedPlan = {
        kind: "plan",
        title: args.title ?? "",
        steps: (args.steps ?? []).map((step) => ({
          text: step.text,
          ...(step.from !== undefined && { from: step.from }),
          ...(step.to !== undefined && { to: step.to }),
        })),
        ...(args.length !== undefined && { length: args.length }),
        ...(args.style !== undefined && { style: args.style }),
      };
      const result = answer(
        call,
        [
          "The plan is shown to the user, who can change it. Their answer, or the plan as they accept it, comes as the next user message.",
        ],
        { plan },
      );
      return { ...result, terminate: true };
    }
    const question: ProposedQuestion = {
      kind: "question",
      question: args.question ?? "",
      options: (args.options ?? []).map(({ label, detail }) => ({
        label,
        ...(detail !== undefined && { detail }),
      })),
      ...(args.allow_other !== undefined && { allow_other: args.allow_other }),
    };
    const result = answer(
      call,
      ["The question is shown to the user. Their answer comes as the next user message."],
      { question },
    );
    return { ...result, terminate: true };
  },
};

const CheckParams = z.strictObject({
  checks: z
    .array(z.enum(["format", "problems"]))
    .optional()
    .describe(PARAM),
  severity: z
    .array(z.enum(["error", "warning", "check"]))
    .optional()
    .describe(PARAM),
  subject: z.string().optional().describe(PARAM),
  limit: z.number().int().min(1).max(500).optional().describe(PARAM),
  cursor: z.string().optional().describe(PARAM),
});

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  unsupported: "project data",
  properties: "scene properties",
  runtime: "scene runtime (scenes the editor ran)",
  editor: "code editor",
  folder: "project folder",
  import: "import",
};

type Owner = { readonly kind: "scene" | "sound"; readonly id: string };

/** The scene or sound whose code a file is, by its path; shared code is every one's. */
function ownersOfPath(state: ProjectState, path: string): readonly Owner[] {
  const [top, id] = path.split("/");
  if (top === "scenes" && id !== undefined && entryOf(state.scenes, id))
    return [{ kind: "scene", id }];
  if (top === "sounds" && id !== undefined && entryOf(state.sounds, id))
    return [{ kind: "sound", id }];
  if (top === "code") {
    return [
      ...Object.keys(state.scenes).map((scene) => ({ kind: "scene", id: scene }) as const),
      ...Object.keys(state.sounds).map((sound) => ({ kind: "sound", id: sound }) as const),
    ];
  }
  return [];
}

/** The scene or sound a problem of the runtime came from. */
function ownerOf(problem: ProjectProblem): Owner | undefined {
  const { subject } = problem;
  if (subject?.kind === "scene" || subject?.kind === "sound")
    return { kind: subject.kind, id: subject.id };
  const [top, id] = (problem.file ?? "").split("/");
  if ((top === "scenes" || top === "sounds") && id !== undefined) {
    return { kind: top === "scenes" ? "scene" : "sound", id };
  }
  return undefined;
}

/** Whether any clip shows or plays a scene or a sound. */
function hasClips(state: ProjectState, { kind, id }: Owner): boolean {
  return Object.values(state.timelines).some((timeline) =>
    Object.values(timeline.clips).some(
      ({ source }) =>
        (kind === "scene" && source.kind === "scene" && source.scene === id) ||
        (kind === "sound" && source.kind === "sound" && source.sound === id),
    ),
  );
}

/** Code this conversation changed that has not run since, a line for each scene or sound. */
function notRunLines(
  state: ProjectState,
  changed: ReadonlySet<string>,
  ran: (owner: Owner) => boolean,
): string[] {
  const byOwner = new Map<string, { owner: Owner; paths: string[] }>();
  for (const path of changed) {
    if (entryOf(state.files, path) === undefined) continue;
    for (const owner of ownersOfPath(state, path)) {
      if (ran(owner)) continue;
      const key = `${owner.kind}\n${owner.id}`;
      const entry = byOwner.get(key) ?? { owner, paths: [] };
      byOwner.set(key, entry);
      entry.paths.push(path);
    }
  }
  return [...byOwner.values()].slice(0, 20).map(({ owner, paths }) => {
    const { kind, id } = owner;
    const why = !hasClips(state, owner)
      ? `${kind} ${id} has no clips, so it does not run`
      : kind === "scene"
        ? `scene ${id} runs while one of its clips is in the preview`
        : `sound ${id} runs when the editor makes it for its clips`;
    return `not run since changed: ${paths.join(", ")} (${why})`;
  });
}

export const checkRun: ToolDefinition<z.output<typeof CheckParams>> = {
  name: "aq_check_run",
  title: "Check the project",
  params: CheckParams,
  run: (call, args) => {
    const { store, host } = call;
    const offset = offsetOf(call, "aq_check_run", args);
    if (typeof offset !== "number") return offset;
    const state = store.getState();
    const checks = new Set(args.checks ?? ["format", "problems"]);
    const head: string[] = [];
    let format = "";
    if (checks.has("format")) {
      const { problems } = store.exportFiles();
      format =
        problems.length === 0 ? "format: ok" : `format: ${problems.length} documents do not fit`;
      for (const problem of problems.slice(0, 20)) {
        head.push(
          `E invalid-document ${problem.file}${problem.path ? ` at ${problem.path}` : ""}: does not fit the project format, so it is not saved until it is fixed`,
        );
      }
    }
    let listed: readonly ProjectProblem[] = [];
    if (checks.has("problems")) {
      const set = host.problems();
      const severities = args.severity && new Set<ProblemSeverity>(args.severity);
      listed = set
        .all()
        .filter(
          (problem) =>
            (!severities || severities.has(problem.severity)) &&
            (args.subject === undefined ||
              problem.subject?.id === args.subject ||
              problem.file === args.subject),
        );
      const sources = set.sources().map((source) => SOURCE_WORDS[source] ?? source);
      const ran = set.sources().includes("runtime") ? "" : "; scene runtime: not checked here";
      head.unshift(`sources: ${sources.join(", ")}${ran}`);
      const errors = listed.filter(({ severity }) => severity === "error").length;
      head.unshift(
        `${errors} errors, ${listed.length - errors} warnings${format ? `; ${format}` : ""}`,
      );
    } else {
      head.unshift(format);
    }
    // What changed since the editor last ran it: what code threw then is from before the change.
    const ran = host.ranNow && ((owner: Owner) => host.ranNow?.(owner, state) === true);
    if (ran) head.push(...notRunLines(state, call.caller.changedCode, ran));
    const before = (problem: ProjectProblem) => {
      const owner = problem.source === "runtime" ? ownerOf(problem) : undefined;
      return ran && owner && !ran(owner) ? "from the code before its last change" : undefined;
    };
    const items = listed.flatMap((problem) =>
      problemLines(state, problem, before(problem)).join("\n"),
    );
    const subjects = listed.flatMap(({ subject }) => (subject ? [objectKey(subject)] : []));
    return paged(call, "aq_check_run", args, {
      head,
      items,
      offset,
      limit: args.limit ?? call.limits.problems,
      title: (first, last, total) => `problems ${first}-${last} of ${total}:`,
      data: {
        problems: listed.map(({ id, code, severity }) => ({ id, code, severity })),
        subjects,
      },
    });
  },
};
