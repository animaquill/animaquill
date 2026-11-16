import type {
  ProjectState,
  ClipDescription,
  Rect,
  ClipState,
  Origin,
  ProblemSet,
  ProjectStore,
  StaticInputs,
} from "@animaquill/core";
import type { Approval, ApproveRequest } from "./approve.ts";

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
 * A message of the user in the conversation that the tools work for, with what the editor showed as
 * it was sent: what `aq_selection_read` at "sent" reads.
 */
export interface SentMessage {
  /** As the user wrote it. */
  readonly text: string;
  /** What the editor showed as it was sent; none where the message is from before it was kept. */
  readonly selection?: SelectionFacts;
}

/**
 * Where the tools work: the project, who the changes are made as, and what only some hosts know,
 * such as what the editor selected and what scenes said about themselves when they ran.
 */
export interface ToolHost {
  store(): ProjectStore | undefined;
  /** Who changes the project, such as `aiTask(task)`: the user can take all of it back at once. */
  origin(): Origin;
  /**
   * Which answer of the model the calls now are of, as an id that changes with each answer: what
   * failed in one answer holds back only the changes after it in that answer. Hosts that leave it
   * out call `CallerState.beginAnswer` at the start of each answer instead, see there.
   */
  answer?(): string | undefined;
  selection?(): SelectionFacts | undefined;
  /**
   * The messages of the user in the conversation, oldest first, the one the task started with last.
   * Only a host with the conversation has them, as the chat of the editor does; through MCP, the
   * conversation is the client's, and there are none.
   */
  sent?(): readonly SentMessage[];
  /** What a scene says about the properties of a clip, once the editor ran it. */
  describe?(clip: ClipState): ClipDescription | undefined;
  /** All problems the host knows of, including what scene code threw. */
  problems(): ProblemSet;
  /** What the problems of the project alone need, to tell what a batch of operations changes. */
  problemInputs?(): StaticInputs;
  /**
   * Whether the code of a scene or a sound, as it is in `state`, has run in the editor since it
   * last changed: a scene runs while one of its clips is in the preview. Hosts that run no code,
   * such as a command line, leave it out, and then nothing is said about it.
   */
  ranNow?(
    object: { readonly kind: "scene" | "sound"; readonly id: string },
    state: ProjectState,
  ): boolean;
  /**
   * Renders frames, as the export renders them, which only a place with an editor can: see
   * `aq_render_frames`. It waits for people to stop playing and for the page to show, and never
   * gives a picture with something missing in it.
   */
  look?(request: LookRequest): Promise<LookAnswer>;
  /** The project as it was when the task started, to compare with. */
  taskStart?(): ProjectState | undefined;
  /**
   * Mixes a part of a timeline as the export mixes it, and measures it, which only a place with an
   * editor can: see `aq_audio_analyze`.
   */
  listen?(request: ListenRequest): Promise<ListenAnswer>;
  /**
   * People asked for a plan first ("先出方案"): every tool that changes the project answers
   * `plan-first` and writes nothing, whatever its parameters, see `makeTool`. As the message the task
   * started with says, not as the switch is now. Hosts that leave it out never ask for one, such as
   * the MCP of a folder, whose clients have plan modes of their own.
   */
  planFirst?(): boolean;
  /**
   * People want to be asked before AI changes the project ("AI 改项目前先问我", S-D4): every tool that
   * changes it previews the change, gives it here, and writes it only once this answers "once" or
   * "task", exactly as previewed and against the project as it was then, see `makeTool`. Read at
   * each call: a host gives it only while people want to be asked, and leaves it out otherwise, as
   * the MCP of a folder always does, whose clients ask in their own way. It answers "stopped" where
   * the task stopped while it waited, and never writes anything itself.
   */
  readonly approve?: ((request: ApproveRequest) => Promise<Approval>) | undefined;
  /**
   * Whether the task these calls are of stopped, as people stopping it: a change people allowed is
   * not written once it did, also where the stop came right after their answer.
   */
  stopped?(): boolean;
}

/**
 * A picture a tool gives, kept where the host keeps the pictures of conversations: by the SHA-256 of
 * its bytes, as `ImageRef` of the agent has it. The bytes never go through the tools.
 */
export interface ToolImage {
  /** `sha256:` and the hash of its bytes, in hex. */
  readonly image: string;
  /** Its media type, such as image/jpeg. */
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** For the model, in English: which picture it is. Where it does not go, this line goes alone. */
  readonly note: string;
  /** What it is of the call, for people: see `LookImageRole`. */
  readonly role?: LookImageRole;
  /** Which shot of the call it is of, from 0. */
  readonly shot?: number;
  /** For people only: it never goes to the model, as the frame without its boxes. */
  readonly forPeople?: true;
}

/**
 * What a picture of `aq_render_frames` is: a frame as the model gets it (with its boxes where it
 * asked for them), the same frame without them, the frame before and after a change and what
 * differs between them, or an overview of many frames in one picture.
 */
export type LookImageRole = "frame" | "clean" | "before" | "after" | "diff" | "sheet";

/** How large the pictures of `aq_render_frames` are: 512, 1024 or 1568 pixels on the longer side. */
export type LookSize = "small" | "medium" | "large";

/** A box drawn on a frame, with the name of what it is: in world units. */
export interface LookMark {
  readonly box: Rect;
  readonly label: string;
  /** Part of it is off the picture: it is drawn red. */
  readonly problem: boolean;
}

/** One moment to render. */
export interface LookShot {
  /** On the timeline. */
  readonly seconds: number;
  /** As an overview prints it in its cell, such as "0:12". */
  readonly label: string;
  readonly marks: readonly LookMark[];
}

/** What `aq_render_frames` asks the host to render, which only an editor can. */
export interface LookRequest {
  readonly state: ProjectState;
  /** The project as it was, for a picture before and one of what differs. */
  readonly before?: ProjectState;
  readonly timeline: string;
  /** The picture format, by id; the first one without it. */
  readonly format: string | undefined;
  /** "frames": a picture of each shot. "sheet": all of them in one picture, `columns` wide. */
  readonly kind: "frames" | "sheet";
  readonly shots: readonly LookShot[];
  readonly columns?: number;
  /** As the settings say where it is not given. */
  readonly size: LookSize | undefined;
  /** Only this part of the picture, in world units, rendered at the size asked for. */
  readonly region?: Rect;
  /** Whether to measure the text of scenes, see `LookTexts`. */
  readonly texts: boolean;
}

/** The text of a scene, as the page of the scene lays it out: in its CSS pixels, from its top left. */
export interface LookText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The text that the scene of a clip shows on a frame. */
export interface LookTexts {
  /** The clip, by id. */
  readonly layer: string;
  readonly texts: readonly LookText[];
  /** It had more than it gave. */
  readonly more?: true;
}

/** Why a frame could not be rendered: the picture never has something missing in it. */
export type LookFailure =
  | { readonly reason: "missing-file"; readonly layer: string; readonly file: string }
  | { readonly reason: "cannot-decode"; readonly layer: string; readonly file: string }
  | {
      readonly reason: "scene";
      readonly layer: string;
      /** How the scene is doing, as `SceneStatus.state` has it. */
      readonly state: string;
      readonly message?: string;
    }
  | { readonly reason: "transition"; readonly layer: string }
  | {
      readonly reason: "scene-frame";
      readonly layer: string;
      readonly wanted: number;
      readonly got?: number;
    }
  | { readonly reason: "encoder" | "failed"; readonly message: string }
  | { readonly reason: "compositor" }
  /** The task stopped while it waited or rendered. */
  | { readonly reason: "stopped" };

/** What the host rendered of one shot. */
export interface LookedShot {
  /** As the model gets it; none where it does not see pictures. */
  readonly picture?: Omit<ToolImage, "note" | "role" | "shot">;
  /** The same without its boxes, for people. */
  readonly clean?: Omit<ToolImage, "note" | "role" | "shot">;
  /** Of a comparison: the frame as it was, and where they differ. */
  readonly before?: Omit<ToolImage, "note" | "role" | "shot">;
  readonly diff?: Omit<ToolImage, "note" | "role" | "shot">;
  /** Of a comparison: the share of the pixels that differ, and where, in pixels of the picture. */
  readonly changed?: {
    readonly ratio: number;
    readonly box?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  };
  /** The text of the scenes on it, see `LookRequest.texts`. */
  readonly texts?: readonly LookTexts[];
}

export type LookAnswer =
  | {
      readonly ok: true;
      /** Whether the model gets the pictures. */
      readonly sees: boolean;
      /** Of each picture, in pixels. */
      readonly width: number;
      readonly height: number;
      /** One for each shot, or one for a sheet. */
      readonly shots: readonly LookedShot[];
    }
  | {
      readonly ok: false;
      /** Which shot, from 0, and whether it was the picture before a change. */
      readonly shot: number;
      readonly before?: true;
      readonly failure: LookFailure;
    };

/** One result of a tool, as text for the model and data for the host. */
export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
  /** Pictures that go to the model before the text, kept by the host. */
  readonly images?: readonly ToolImage[];
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
  readonly annotations: ToolAnnotations;
  /**
   * Whether a call of the model fits the parameters, as the error the call would give, or undefined:
   * hosts check before they run it, the way they check every call. One that does not fit counts as a
   * failed change for what comes after it in the same answer, as when `run` finds it.
   */
  validate(args: unknown): ToolResult | undefined;
  run(args: unknown): Promise<ToolResult>;
}

/** What `aq_audio_analyze` asks the host to mix and measure. */
export interface ListenRequest {
  readonly state: ProjectState;
  readonly timeline: string;
  /** Seconds on the timeline. */
  readonly from: number;
  readonly to: number;
  /** Only this clip, by id, as if nothing else sounded. */
  readonly only?: string;
  /** Whether to measure the envelope. */
  readonly envelope: boolean;
  /** How many parts the small picture of the level has. */
  readonly buckets: number;
}

/**
 * What the host measured of a mix, as `SoundMeter` of the audio has it: levels in dB, `null` for
 * silence (minus infinity), times in seconds from `ListenRequest.from`.
 */
export interface Heard {
  readonly seconds: number;
  readonly integrated?: number;
  readonly shortTermMax?: number;
  readonly momentaryMax?: number;
  readonly truePeak: number | null;
  readonly samplePeak: number | null;
  readonly clipping: { readonly places: number; readonly samples: number };
  readonly clips: readonly {
    readonly from: number;
    readonly to: number;
    readonly samples: number;
  }[];
  readonly silences: readonly { readonly from: number; readonly to: number }[];
  readonly silent: boolean;
  readonly envelope?: {
    readonly peak: number;
    readonly peakAt: number;
    readonly onset: number;
    readonly attack: number;
    readonly decay: number;
    readonly cut: boolean;
  };
  /** The largest sample of each part, 0–1, for a small picture. */
  readonly wave: readonly number[];
}

/** Why a part of a timeline could not be mixed: nothing is measured of a mix with a sound missing. */
export type ListenFailure =
  | {
      readonly reason: "missing-file" | "cannot-decode";
      readonly layer: string;
      readonly file: string;
    }
  /** Code did not make the sound of a clip, see the sounds of the editor. */
  | { readonly reason: "not-made"; readonly layer: string; readonly why: string }
  | { readonly reason: "failed"; readonly message: string }
  | { readonly reason: "stopped" };

export type ListenAnswer =
  | { readonly ok: true; readonly heard: Heard }
  | { readonly ok: false; readonly failure: ListenFailure };
