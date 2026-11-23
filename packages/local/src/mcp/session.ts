import { randomBytes } from "node:crypto";
import type { BridgeClient, BridgeResult } from "@animaquill/tools";
import type { RelayLink } from "./link.ts";
import type { Bound, Target } from "./relay.ts";
import type { Found } from "./target.ts";

/**
 * One session of an AI tool through `animaquill mcp` (docs/design/online-offline.md of AnimaQuill
 * Cloud, 5): what it works on, and its calls, which run in the editor in the browser that has that
 * project open. Calls that come in while others wait count as one answer of the model, as an AI tool
 * sends the calls of one answer together: a change that failed holds back the changes after it there,
 * not those of the next. Which project the calls work on is said in the first result, and again where
 * it changes, and by `aq_project_status`.
 */

export const newId = (): string => randomBytes(6).toString("hex");

const failed = (text: string): BridgeResult => ({ text, isError: true });

const sameProject = (a: Bound | undefined, b: Bound | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.origin === b.origin &&
  a.project.mode === b.project.mode &&
  a.project.key === b.project.key;

/** Which project it is, as the line before a result says it. */
function projectLine(bound: Bound, target: Target): string {
  const { name, mode, link } = bound.project;
  const where =
    mode === "online"
      ? `online${link ? `, ${link}` : ""}`
      : target.kind === "folder"
        ? `offline, the folder ${target.root} on this computer`
        : "offline, a folder on this computer";
  return `project: ${JSON.stringify(name)} (${where})`;
}

/** What the editor not having the project open says, for the target there is. */
function notOpen(target: Target): string {
  const what =
    target.kind === "folder"
      ? `the project in the folder ${target.root}`
      : target.kind === "link"
        ? `the project ${target.origin}/p/${encodeURIComponent(target.project)}`
        : target.bound
          ? `the project ${JSON.stringify(target.bound.project.name)} that this session worked on`
          : "any project";
  return `error editor-not-open: no AnimaQuill editor on this computer has ${what} open and connected to AI tools on this computer, so nothing was done. The call runs once ${what === "any project" ? "a project" : "it"} is open in the AnimaQuill editor in Chrome or Edge, connected (AnimaQuill settings › AI tools on this computer › Connect).`;
}

export interface McpSessionOptions {
  readonly link: RelayLink;
  /** Finds what the session works on, once. */
  readonly find: (session: string) => Promise<Found>;
  readonly now?: () => number;
}

export class McpSession {
  readonly session = newId();
  readonly #options: McpSessionOptions;
  readonly #since: number;
  #found: Promise<Found> | undefined;
  #client: BridgeClient | undefined;
  #target: Target | undefined;
  #told: Bound | undefined;
  #calls = 0;
  #pending = 0;
  #answers = 0;

  constructor(options: McpSessionOptions) {
    this.#options = options;
    this.#since = (options.now ?? Date.now)();
  }

  /** Finds the project, once, in the background: the first call waits for it. */
  open(): Promise<Found> {
    this.#found ??= this.#options.find(this.session).then((found) => {
      if (found.kind === "target") {
        this.#target = found.target;
        this.#tell();
      }
      return found;
    });
    return this.#found;
  }

  /** The AI tool said who it is, as MCP has it (`clientInfo`). */
  named(client: BridgeClient | undefined): void {
    if (!client || (client.name === this.#client?.name && client.version === this.#client?.version))
      return;
    this.#client = client;
    this.#tell();
  }

  get client(): BridgeClient | undefined {
    return this.#client;
  }

  #tell(): void {
    const target = this.#target;
    if (!target) return;
    this.#options.link.session({
      session: this.session,
      ...(this.#client && { client: this.#client }),
      target,
      since: this.#since,
    });
  }

  call(name: string, args: unknown, signal?: AbortSignal): Promise<BridgeResult> {
    if (this.#pending === 0) this.#answers += 1;
    this.#pending += 1;
    const answer = String(this.#answers);
    return this.#run(name, args, answer, signal).finally(() => {
      this.#pending -= 1;
    });
  }

  async #run(
    name: string,
    args: unknown,
    answer: string,
    signal: AbortSignal | undefined,
  ): Promise<BridgeResult> {
    const found = await this.open();
    if (found.kind === "none") return failed(found.reason);
    const target = this.#target ?? found.target;
    this.#calls += 1;
    const result = await this.#options.link.call(
      { call: `${this.session}-${this.#calls}`, session: this.session, answer, tool: name, args },
      signal,
    );
    if (result.kind === "no-page") return failed(notOpen(target));
    if (result.kind === "gone") {
      return failed(
        "error editor-closed: the editor that ran the call went away before it answered, so whether it was done is not known; aq_project_status tells how the project is now.",
      );
    }
    const { bound } = result;
    const changed = !sameProject(this.#told, bound);
    if (changed) {
      this.#told = bound;
      // Whatever was in front is the project of this session from now on.
      if (target.kind === "front") {
        this.#target = { kind: "front", bound };
        this.#tell();
      }
    }
    if (!changed && name !== "aq_project_status") return result.result;
    return { ...result.result, text: `${projectLine(bound, target)}\n${result.result.text}` };
  }

  close(): void {
    this.#options.link.end(this.session);
  }
}
