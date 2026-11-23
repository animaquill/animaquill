import { ProblemSet, ProjectStore, type ProjectProblem } from "@animaquill/core";
import { createProject } from "@animaquill/schema";
import { CallerState, createToolset, type ToolHost } from "@animaquill/tools";
import type { Problem } from "@animaquill/schema";
import { FolderProject } from "./folder-project.ts";
import type { ProjectPlace } from "./find.ts";

/**
 * The commands of the command line on a project folder, which read and write nothing but what they
 * print: `check`, `describe` and `guide`. Each says what it found in the words of the tools, which
 * are English, as AI and scripts read them.
 */

/** What a tool says, without the revision it starts with: that is for AI to send back. */
const withoutRevision = (text: string) => text.replace(/^rev [^\n]*\n/, "");

export interface Output {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** A problem as `check --json` gives it. */
interface CheckedProblem {
  readonly severity: "error" | "warning" | "check";
  readonly code: string;
  readonly file?: string;
  readonly subject?: string;
  readonly message?: string;
}

const fromFolder = ({ severity, code, file, message }: Problem): CheckedProblem => ({
  severity,
  code,
  file,
  message,
});

const fromProject = ({ severity, code, file, subject }: ProjectProblem): CheckedProblem => ({
  severity,
  code,
  ...(file !== undefined && { file }),
  ...(subject && { subject: `${subject.kind} ${subject.id}` }),
});

async function opened(place: ProjectPlace, { err }: Output): Promise<FolderProject | undefined> {
  if (place.kind === "none") {
    err(place.reason.replace(/^error no-project: /, ""));
    return undefined;
  }
  try {
    return await FolderProject.open(place.root);
  } catch (error) {
    err(`${place.root} cannot be opened as an AnimaQuill project: ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * `animaquill check [--json]`: what is wrong with the project that the project alone tells, as the
 * editor reads the folder. Exits with 1 when there is an error, 2 when there is no project.
 */
export async function check(place: ProjectPlace, json: boolean, output: Output): Promise<number> {
  const project = await opened(place, output);
  if (!project) return 2;
  try {
    const { reading, store } = project;
    const problems = new ProblemSet();
    problems.update(store.getState());
    const found: CheckedProblem[] = [
      ...reading.lost.flatMap(({ problems: lost }) => lost.map(fromFolder)),
      ...reading.warnings.map(fromFolder),
      ...problems.all().map(fromProject),
    ];
    const errors = found.filter(({ severity }) => severity === "error").length;
    if (json) {
      output.out(JSON.stringify({ root: project.root, errors, problems: found }, null, 2));
    } else {
      output.out(
        `${errors} errors, ${found.length - errors} warnings and checks in ${project.root}`,
      );
      for (const { severity, code, file, subject, message } of found) {
        const where = [file, subject].filter(Boolean).join(", ");
        output.out(
          `${severity[0]?.toUpperCase()} ${code}${where ? ` ${where}` : ""}${message ? `: ${message}` : ""}`,
        );
      }
    }
    return errors > 0 ? 1 : 0;
  } finally {
    project.destroy();
  }
}

/** The tools on a project that only read, for `describe`. */
function readingTools(store: ProjectStore) {
  const problems = new ProblemSet();
  const host: ToolHost = {
    store: () => store,
    origin: () => "nobody",
    problems: () => {
      problems.update(store.getState());
      return problems;
    },
  };
  return createToolset(host, new CallerState());
}

/** `animaquill describe`: what the project is, as aq_project_status and aq_timeline_read say it. */
export async function describe(place: ProjectPlace, output: Output): Promise<number> {
  const project = await opened(place, output);
  if (!project) return 2;
  try {
    const tools = readingTools(project.store);
    const run = (name: string, args: unknown) =>
      tools.find((tool) => tool.name === name)?.run(args);
    const status = await run("aq_project_status", {});
    output.out(withoutRevision(status?.text ?? ""));
    for (const timeline of Object.keys(project.store.getState().timelines).toSorted()) {
      const read = await run("aq_timeline_read", { timeline });
      if (read && !read.isError) output.out(`\n${withoutRevision(read.text)}`);
    }
    return status?.isError ? 1 : 0;
  } finally {
    project.destroy();
  }
}

/** `animaquill guide [<topic>] [--query <words>]`: the manual, as aq_guide reads it. Needs no project. */
export async function guide(
  topic: string | undefined,
  query: string | undefined,
  output: Output,
): Promise<number> {
  // The manual is the same for every project: an empty one does.
  const store = ProjectStore.create(createProject({ name: "guide" }));
  const tool = readingTools(store).find(({ name }) => name === "aq_guide");
  const result = await tool?.run({
    ...(topic !== undefined && { topic }),
    ...(query !== undefined && { query }),
  });
  store.destroy();
  if (!result) return 1;
  (result.isError ? output.err : output.out)(withoutRevision(result.text));
  return result.isError ? 1 : 0;
}
