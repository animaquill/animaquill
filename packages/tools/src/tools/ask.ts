import {
  entryOf,
  objectKey,
  type ProblemSeverity,
  type ProjectProblem,
  type ProjectState,
} from "@animaquill/core";
import { z } from "zod";
import { answer, failed } from "../context.ts";
import { offsetOf, paged } from "../page.ts";
import { problemLines } from "../problems-en.ts";
import { PARAM } from "../texts/index.ts";
import type { ToolDefinition } from "../tool.ts";

const ProposeParams = z.strictObject({
  kind: z.literal("question").describe(PARAM),
  question: z.string().min(1).max(300).describe(PARAM),
  options: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(80).describe(PARAM),
        detail: z.string().max(200).optional().describe(PARAM),
      }),
    )
    .min(2)
    .max(6)
    .describe(PARAM),
  allow_other: z.boolean().optional().describe(PARAM),
});

export const propose: ToolDefinition<z.output<typeof ProposeParams>> = {
  name: "aq_propose",
  title: "Ask the user",
  params: ProposeParams,
  run: (call, args) => {
    const { caller } = call;
    if (caller.answer.proposed) {
      return failed(
        "error one-at-a-time: this answer already asks the user a question; one question per answer.",
      );
    }
    caller.hold("asked");
    const result = answer(
      call,
      ["The question is shown to the user. Their answer comes as the next user message."],
      {
        question: args,
      },
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
