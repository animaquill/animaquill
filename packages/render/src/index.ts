import type { Channel, RenderLayer, RenderPlan } from "@animaquill/core";
import type {
  SceneFailure,
  ScenePhase,
  SceneProblem,
  SoundFailureReason,
  SoundLoad,
} from "@animaquill/scene";

export { layerWith, type LayerChanges } from "./plan.ts";

export interface FrameTiming {
  /** Where on the timeline. */
  readonly seconds: number;
  /** How long this frame took. */
  readonly ms: number;
  /** Of that, how long it waited for pictures. The rest is drawing. */
  readonly decodeMs: number;
  /** Whether the next clip was being prepared meanwhile, which competes for the decoder. */
  readonly gettingReady: boolean;
  /** Videos that had to start decoding at a keyframe for it. This is what causes a stutter. */
  readonly cold: number;
  /** How far time had moved on by the time it was done. */
  readonly behindMs: number;
  /** Frames given up before this one because the playhead left them. They have no timing of their own. */
  readonly abandoned: number;
}

/** What changed about the curves of a layer, by property path. Null takes a property away. */
export type ChannelChanges = Readonly<Record<string, Channel | null>>;

/** What the compositor needs to know to run scenes. Comes first, and only comes once. */
export interface SceneSetup {
  /** Where scenes run. None means a host that has no way of running them. */
  readonly origins: readonly string[];
  /** Where they must not run any more, see `OriginPool`. That outlives a compositor. */
  readonly retired?: readonly string[];
  /** Where the compositor itself is, which scenes must stay away from. */
  readonly compositor: string;
  /** For development: a normal page with no capture, to run scenes in any browser. */
  readonly stage?: "plain";
  /** False to get out of a project that takes the preview down whenever it opens. */
  readonly run: boolean;
}

/** How a scene is doing, for showing that to people. */
export interface SceneStatus {
  readonly state:
    /** It is on its way. Nothing is wrong, and until then there is no picture of it. */
    | "opening"
    | "ready"
    /** It hung, and it is being started again. */
    | "retrying"
    /** This browser cannot capture it. */
    | "unsupported"
    /** It was written for a newer editor. */
    | "too-new"
    /** Scenes are not running, because somebody said so. */
    | "off"
    /** It failed for good, until somebody retries. */
    | "stopped"
    | "closed";
  readonly reason?: SceneFailure["reason"];
  /** What the scene said, for `failed`. */
  readonly message?: string;
  /** What it was doing, and which frame it was on and on its way to. */
  readonly phase?: ScenePhase;
  readonly frame?: number;
  readonly target?: number;
}

/** The time of something that goes on by itself. */
export interface PlayBase {
  /** Where on the timeline. */
  readonly seconds: number;
  /** When, as `performance.timeOrigin + performance.now()`, which agrees between processes. */
  readonly at: number;
  /** Timeline seconds per real second. */
  readonly rate: number;
  /** Somebody moved the playhead, as opposed to the time being corrected a little. */
  readonly jump: boolean;
}

/** From the editor to the compositor. */
export type ToCompositor =
  | ({ readonly type: "setup" } & SceneSetup)
  | {
      readonly type: "plan";
      readonly plan: RenderPlan;
      /** The project without what `plan` has on top of it, if it has anything. */
      readonly settled?: RenderPlan;
    }
  /** Changes one layer on the spot, for what is not in the project yet. A new plan ends it. */
  | {
      readonly type: "channels";
      readonly layer: string;
      readonly channels: ChannelChanges;
      readonly fit?: RenderLayer["fit"];
    }
  | { readonly type: "file"; readonly id: string; readonly file: Blob }
  /** A jump is somebody moving the playhead, as opposed to time carrying it along while playing. */
  | { readonly type: "seek"; readonly seconds: number; readonly jump: boolean }
  /**
   * Time goes on by itself from here on, for what can follow it without being told every frame.
   * Sent again now and then to correct it, and after a jump.
   */
  | ({ readonly type: "play" } & PlayBase)
  | { readonly type: "pause" }
  /** What a scene is made of. It gets this and nothing else. */
  | {
      readonly type: "scene-files";
      readonly scene: string;
      readonly revision: string;
      /** By path from the root of the project. */
      readonly files: ReadonlyMap<string, Blob>;
      /** By id. */
      readonly assets: ReadonlyMap<string, Blob>;
    }
  /** Somebody wants to give a scene that stopped another chance. */
  | { readonly type: "scene-retry"; readonly layer: string }
  /** Runs the code of a sound, which comes back as `sound-done` or `sound-failed`. */
  | { readonly type: "sound-make"; readonly request: number; readonly load: SoundLoad }
  /** Nobody needs that sound any more. */
  | { readonly type: "sound-cancel"; readonly request: number }
  /** The samples of a sound have been read, so what made them can go. */
  | { readonly type: "sound-release"; readonly request: number }
  /** The frame with this index, out of this many, keeps writing to the editor. */
  | { readonly type: "evict"; readonly index: number; readonly frames: number }
  /** A frame in here took the keyboard. Only while it still has it can this page tell which one. */
  | { readonly type: "focus-taken"; readonly request: number }
  /** Whether this page is still there. */
  | { readonly type: "ping"; readonly nonce: number }
  /** Timing costs little, but nothing should run that nobody asked for. */
  | { readonly type: "record"; readonly on: boolean }
  /** Asks for evenly spread frames of a video, side by side in one image. */
  | {
      readonly type: "strip";
      readonly request: number;
      readonly file: Blob;
      readonly count: number;
      readonly height: number;
    };

/** From the compositor to the editor. */
export type FromCompositor =
  | { readonly type: "ready" }
  /** It needs this file. Nothing leaves the sandbox on its own, and nothing comes in by itself. */
  | { readonly type: "needs"; readonly id: string }
  | { readonly type: "cannot-decode"; readonly id: string }
  /** It needs this scene, in this state. */
  | { readonly type: "needs-scene"; readonly scene: string; readonly revision: string }
  | { readonly type: "scene-status"; readonly layer: string; readonly status: SceneStatus }
  /** With the state of the scene it came from: a newer one may have nothing wrong with it. */
  | {
      readonly type: "scene-problem";
      readonly layer: string;
      readonly revision: string;
      readonly problem: SceneProblem;
    }
  /** What came out of the code of a sound. Only ever data, and checked again on arrival. */
  | {
      readonly type: "sound-done";
      readonly request: number;
      readonly channels: number;
      readonly frames: number;
      readonly samples: Blob;
    }
  | { readonly type: "sound-failed"; readonly request: number; readonly reason: SoundFailureReason }
  | { readonly type: "sound-problem"; readonly request: number; readonly problem: SceneProblem }
  /** It looked at who took the keyboard. */
  | { readonly type: "focus-checked"; readonly request: number }
  /** Scenes must stay away from there, also in the next compositor. */
  | { readonly type: "origin-retired"; readonly origin: string }
  | { readonly type: "pong"; readonly nonce: number }
  | { readonly type: "frames"; readonly frames: readonly FrameTiming[] }
  | { readonly type: "strip"; readonly request: number; readonly image: ImageBitmap | undefined };
