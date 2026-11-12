import { objectKey, type ProblemSeverity, type ProjectProblem } from "@animaquill/core";
import { z } from "zod";
import { answer, failed } from "../context.ts";
import { offsetOf, paged } from "../page.ts";
import { problemLines } from "../problems-en.ts";
import type { ToolDefinition } from "../tool.ts";

const ProposeParams = z.strictObject({
  kind: z.literal("question").describe('"question": a choice for the user to make.'),
  question: z
    .string()
    .min(1)
    .max(300)
    .describe("The question, in one sentence, in the language of the user."),
  options: z
    .array(
      z.strictObject({
        label: z.string().min(1).max(80).describe("A short answer the user can pick."),
        detail: z.string().max(200).optional().describe("What picking it means, in a few words."),
      }),
    )
    .min(2)
    .max(6)
    .describe("2 to 6 concrete answers."),
  allow_other: z
    .boolean()
    .optional()
    .describe(
      "false when the user must pick one of the options; by default they can also answer in their own words.",
    ),
});

export const propose: ToolDefinition<z.output<typeof ProposeParams>> = {
  name: "aq_propose",
  title: "Ask the user",
  description:
    "Hand a decision to the user and stop this turn to wait for it. Use kind \"question\" when you cannot go on without the user's choice — which of two clips they meant, which of a few styles they want, whether to replace or keep something — and give 2 to 6 short, concrete options; the user can also answer in their own words. Do not ask about what you can find out by reading the project, and ask one question at a time. After calling it, end your turn without further tools: the answer arrives as the user's next message.",
  params: ProposeParams,
  run: (call, args) => {
    const { caller } = call;
    if (caller.answer.proposed) {
      return failed(
        "error one-at-a-time: this answer already asks the user a question; ask one at a time.",
      );
    }
    caller.answer.proposed = true;
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
    .describe(
      '"format": whether every document fits the project format; "problems": all problems the editor knows of. Both by default.',
    ),
  severity: z
    .array(z.enum(["error", "warning", "check"]))
    .optional()
    .describe("Only problems of these kinds."),
  subject: z.string().optional().describe("Only problems of this object id or file path."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("How many problems at most, 1 to 500; 100 by default."),
  cursor: z
    .string()
    .optional()
    .describe("Where to go on, as the last line of an earlier result of this call says."),
});

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  unsupported: "project data",
  properties: "scene properties",
  runtime: "scene runtime (scenes the editor ran)",
  editor: "code editor",
  folder: "project folder",
  import: "import",
};

export const checkRun: ToolDefinition<z.output<typeof CheckParams>> = {
  name: "aq_check_run",
  title: "Check the project",
  description:
    "Check the project and list its problems: files that do not fit the project format, references to things that are missing, values that do not fit what a scene describes, errors that scene and sound code threw when the editor ran it, and things this editor version does not do yet (they will not appear in the preview or the export). Run it after changing code, and before you tell the user you are done; fix the problems you caused and mention the others. Problems with a fix line are fixed by sending that operation to aq_edit. Runtime errors only come from code the editor has run, which happens shortly after a change; aq_edit results already include the problems that come from the project data alone.",
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
    const items = listed.flatMap((problem) => problemLines(state, problem).join("\n"));
    const subjects = listed.flatMap(({ subject }) => (subject ? [objectKey(subject)] : []));
    return paged(call, "aq_check_run", args, {
      head,
      items,
      offset,
      limit: args.limit ?? 100,
      title: (first, last, total) => `problems ${first}-${last} of ${total}:`,
      data: {
        problems: listed.map(({ id, code, severity }) => ({ id, code, severity })),
        subjects,
      },
    });
  },
};
