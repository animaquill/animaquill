import { FolderRefused, ProblemSet, aiTask } from "@animaquill/core";
import {
  CallerState,
  WRITE_TOOLS,
  createToolset,
  type Tool,
  type ToolHost,
  type ToolResult,
} from "@animaquill/tools";
import { FolderProject } from "./folder-project.ts";
import {
  BatchNotes,
  ConnectionFile,
  newId,
  tidyLeftovers,
  type BatchNote,
  type ClientName,
} from "./notes.ts";

/**
 * The tools on a project folder, as the local MCP and a command line use them: the same tools as in
 * the browser, on a project that is read from the folder and written back to it. Calls go one after
 * the other: each looks at the folder first, and a change is in the files before the next begins.
 */

/** Where the project is, as the server was started, or why there is none. */
export type ProjectPlace =
  | { readonly kind: "folder"; readonly root: string }
  | { readonly kind: "none"; readonly reason: string };

export interface FolderToolsOptions {
  readonly place: ProjectPlace;
  /** Notes on batches and the file that says the connection is on; off for a command line. */
  readonly notes?: boolean;
  readonly now?: () => number;
}

const failed = (text: string): ToolResult => ({ text, isError: true });

/** Why a folder could not be opened, as a tool says it. */
function refusalText(root: string, error: unknown): string {
  if (error instanceof FolderRefused) {
    const problems = error.problems
      .slice(0, 5)
      .map(({ file, message }) => `\n  ${file}: ${message}`)
      .join("");
    const why: Record<FolderRefused["reason"], string> = {
      "not-a-project": "it has no animaquill.json",
      "several-projects": "several folders inside have an animaquill.json",
      incomplete:
        "an export into it did not finish (导出未完成.txt is there, or animaquill.json is empty)",
      "too-many-files": "it has more files than a project can have",
      "too-new":
        "a newer AnimaQuill wrote it than this server is; a newer animaquill package reads it",
      invalid: "animaquill.json does not fit the project format",
    };
    return `error no-project: the folder ${root} is no AnimaQuill project now: ${why[error.reason]}.${problems}`;
  }
  return `error no-project: the folder ${root} could not be read: ${(error as Error).message}`;
}

export class FolderTools {
  readonly tools: readonly Tool[];
  readonly session = newId();
  readonly #options: FolderToolsOptions;
  readonly #caller = new CallerState();
  readonly #problems = new ProblemSet();
  #project: FolderProject | undefined;
  #opening: Promise<FolderProject | string> | undefined;
  #notes: BatchNotes | undefined;
  #connection: ConnectionFile | undefined;
  #client: ClientName | undefined;
  /** Calls one after the other, see the top. */
  #queue: Promise<unknown> = Promise.resolve();
  /** Calls that came in and did not end yet, and which answer of the model they count as. */
  #pending = 0;
  #answers = 0;
  #answer: string | undefined;
  /** Writing the files of the last change failed: the next call writes them first. */
  #unsaved = false;

  constructor(options: FolderToolsOptions) {
    this.#options = options;
    // No `planFirst`, no `approve`: the AI tool has a plan mode of its own, and asks people before
    // a change in its own way (S-D3, S-D4 of the design of changes and gates of AnimaQuill Cloud).
    const host: ToolHost = {
      store: () => this.#project?.store,
      // Everything of one connection is one task of the AI tool.
      origin: () => aiTask(`mcp-${this.session}`),
      answer: () => this.#answer,
      problems: () => {
        this.#problems.update(this.#project?.store.getState());
        return this.#problems;
      },
    };
    this.tools = createToolset(host, this.#caller);
  }

  /**
   * Opens the project, once, in the background: the server answers what it is right away, and the
   * first call waits for the project. Resolves to the project, or to the error that calls give.
   */
  open(): Promise<FolderProject | string> {
    this.#opening ??= this.#open();
    return this.#opening;
  }

  async #open(): Promise<FolderProject | string> {
    const { place } = this.#options;
    if (place.kind === "none") return place.reason;
    try {
      const project = await FolderProject.open(place.root);
      this.#project = project;
      if (this.#options.notes) {
        const now = this.#options.now ?? Date.now;
        this.#notes = new BatchNotes(project.writer, place.root, this.session, now);
        await tidyLeftovers(place.root, project.writer, now()).catch(() => {});
        this.#connection = new ConnectionFile(project.writer, this.session, now);
        if (this.#client) await this.#connection.named(this.#client);
        await this.#connection.start().catch((error: unknown) => {
          console.error("The file that says the connection is on could not be written", error);
        });
      }
      return project;
    } catch (error) {
      return refusalText(place.root, error);
    }
  }

  /** The AI tool said who it is, as MCP has it (`clientInfo`). */
  named(client: ClientName | undefined): void {
    if (!client || (client.name === this.#client?.name && client.version === this.#client?.version))
      return;
    this.#client = client;
    void this.#connection?.named(client).catch(() => {});
  }

  get client(): ClientName | undefined {
    return this.#client;
  }

  /** The batch that the last write went into, for whoever shows it. */
  get batch(): BatchNote | undefined {
    return this.#notes?.current;
  }

  /**
   * Runs a tool: the folder first, then the call, then the files it changed. Calls that come in
   * while others wait count as one answer of the model, as an AI tool sends the calls of one answer
   * together: a change that failed holds back the changes after it there, not those of the next.
   */
  call(name: string, args: unknown): Promise<ToolResult> {
    if (this.#pending === 0) this.#answers += 1;
    this.#pending += 1;
    const answer = String(this.#answers);
    const run = this.#queue.then(() => this.#run(name, args, answer));
    this.#queue = run.catch(() => {});
    return run.finally(() => {
      this.#pending -= 1;
    });
  }

  async #run(name: string, args: unknown, answer: string): Promise<ToolResult> {
    const tool = this.tools.find((each) => each.name === name);
    if (!tool) return failed(`error unknown-tool: there is no tool ${JSON.stringify(name)}.`);
    const opened = await this.open();
    if (typeof opened === "string") return failed(opened);
    const project = opened;
    try {
      await project.refresh();
    } catch (error) {
      return failed(
        `error folder-unreadable: the project folder ${project.root} could not be read: ${(error as Error).message}. Nothing was written.`,
      );
    }
    if (project.trouble) {
      const why =
        project.trouble === "manifest-gone"
          ? "animaquill.json is not in it any more"
          : "an export into it has not finished (导出未完成.txt is there)";
      return failed(
        `error no-project: the folder ${project.root} is no AnimaQuill project right now: ${why}. Nothing was written.`,
      );
    }
    this.#answer = answer;
    if (this.#unsaved) await this.#save(project).catch(() => {});
    const ran = await tool.run(args);
    // Which folder it is, for people to see in their AI tool what is being changed.
    const result =
      name === "aq_project_status" && !ran.isError
        ? { ...ran, text: `${ran.text}\nproject folder: ${project.root}` }
        : ran;
    if (!WRITE_TOOLS.has(name) || result.isError) return result;
    try {
      await this.#save(project);
      if (!this.#unsaved) return result;
      return {
        ...result,
        isError: true,
        text: `${result.text}\nerror write-failed: the change is in the project, and the folder kept changing while its files were written, so some are not written yet. The next call writes them.`,
      };
    } catch (error) {
      return {
        ...result,
        isError: true,
        text: `${result.text}\nerror write-failed: the change is in the project, and writing its files to the folder failed: ${(error as Error).message}. The next call writes them again.`,
      };
    }
  }

  async #save(project: FolderProject): Promise<void> {
    this.#unsaved = true;
    // The note of the batch goes before the files, see `FolderProject.save`.
    await project.save((planned) => this.#notes?.note(planned, this.#client) ?? Promise.resolve());
    this.#unsaved = project.unwritten;
  }

  /** Takes away what says the connection is on. */
  async close(): Promise<void> {
    await this.#connection?.close();
    this.#project?.destroy();
  }
}
