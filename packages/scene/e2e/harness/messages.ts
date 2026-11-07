import type { SceneFailure, SceneProblem } from "../../src/index.ts";

/** What the editor page of the test says to its compositor. */
export interface OpenScene {
  /** By path. Text stays text, and what is not text comes as base64. */
  readonly files: Readonly<Record<string, string | { readonly base64: string }>>;
  readonly assets?: Readonly<Record<string, { readonly base64: string }>>;
  readonly entry: string;
  readonly stage?: "canvas" | "plain";
  readonly fps?: number;
  readonly seed?: number;
  /** Keeps asking for this frame until the scene is ready, without waiting for it. */
  readonly seekAtOnce?: number;
  /** Starts with a frame of no size, like a frame in a process that has not caught up yet. */
  readonly startHidden?: boolean;
  readonly watchdog?: {
    readonly hello?: number;
    readonly loading?: number;
    readonly running?: number;
    readonly seekStallMs?: number;
    readonly replayBurst?: number;
    readonly replaysPerSecond?: number;
  };
  /** Closes the scene from inside the callback that tells about a failure. */
  readonly closeOnFailure?: boolean;
  /** Tighter than the real rules, to get to the limit sooner. */
  readonly messageRules?: {
    readonly burstMessages: number;
    readonly messagesPerSecond: number;
  };
}

export interface Call {
  readonly call: number;
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface Reply {
  readonly reply: number;
  readonly value?: unknown;
  readonly error?: string;
}

/** What the test can see of a scene. */
export interface SceneInfo {
  readonly origin: string | undefined;
  readonly state: string;
  readonly capture: boolean | undefined;
  readonly problems: readonly SceneProblem[];
  readonly failures: readonly SceneFailure[];
  readonly positions: readonly number[];
  readonly frames: number;
}
