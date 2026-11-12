import type {
  ClipDescription,
  ClipState,
  Origin,
  ProblemSet,
  ProjectStore,
  StaticInputs,
} from "@animaquill/core";

/** A JSON Schema, as tools describe their parameters and results. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** What a tool does to the project, for whoever asks before calling it, as MCP has it. */
export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint: false;
}

/** What the editor shows of a window right now. Hosts without an editor have none. */
export interface SelectionFacts {
  readonly timeline: string | undefined;
  /** In seconds, as times in the project are written. */
  readonly playhead: string | undefined;
  /** The version that the editor shows, such as "master" or "en". */
  readonly version?: string;
  readonly clips: readonly string[];
  /** A transition at the edge of a clip, or a join between two. */
  readonly transition?:
    { readonly clip: string; readonly edge: "enter" | "exit" } | { readonly join: string };
  /** The user chose not to share what they selected. */
  readonly hidden?: true;
}

/**
 * Where the tools work: the project, who the changes are made as, and what only some hosts know,
 * such as what the editor selected and what scenes said about themselves when they ran.
 */
export interface ToolHost {
  store(): ProjectStore | undefined;
  /** Who changes the project, such as `aiTask(task)`: the user can take all of it back at once. */
  origin(): Origin;
  selection?(): SelectionFacts | undefined;
  /** What a scene says about the properties of a clip, once the editor ran it. */
  describe?(clip: ClipState): ClipDescription | undefined;
  /** All problems the host knows of, including what scene code threw. */
  problems(): ProblemSet;
  /** What the problems of the project alone need, to tell what a batch of operations changes. */
  problemInputs?(): StaticInputs;
}

/** One result of a tool, as text for the model and data for the host. */
export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
  /** What the call changed or found, for whoever shows it, such as the summary of a turn. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** The turn waits for the user now: no more tools after this one. */
  readonly terminate?: true;
}

export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly annotations: ToolAnnotations;
  /** Whether the call fits the parameters, as the error a call would give, or undefined. */
  validate(args: unknown): ToolResult | undefined;
  run(args: unknown): Promise<ToolResult>;
}
