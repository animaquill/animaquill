import type { Channel, RenderLayer, RenderPlan } from "@animaquill/core";
import type {
  SceneFailure,
  ScenePhase,
  SceneProblem,
  SoundFailureReason,
  SoundLoad,
} from "@animaquill/scene";
import type { StillFailure } from "./still.ts";

export { layerWith, type LayerChanges } from "./plan.ts";
export { failureOf, StillFailed, type StillFailure } from "./still.ts";

/**
 * How many pixels of a corner of the compositor scenes share. A scene that has no pixel of its own on
 * the screen does not get drawn, so a compositor that is not for looking at keeps this much showing.
 */
export const SCENE_CORNER = 16;

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
  /** Which clips `cold` was about. Ids only, never names. */
  readonly coldClips?: readonly ColdClip[];
}

/** A clip whose video had to start decoding at a keyframe for a frame. */
export interface ColdClip {
  readonly layer: string;
  readonly kind: "video";
  /** Of what was decoded, as it shows. */
  readonly width?: number;
  readonly height?: number;
  /** What was decoded is a smaller copy of the video, see `ToCompositor` "file". */
  readonly standIn?: true;
}

/** What changed about the curves of a layer, by property path. Null takes a property away. */
export type ChannelChanges = Readonly<Record<string, Channel | null>>;

/**
 * What changed of what a clip holds for its scene, by path, as the clip stores it: see
 * `RenderLayer.content`. Null takes a path away.
 */
export type ContentChanges = Readonly<
  Record<string, NonNullable<RenderLayer["content"]>[string] | null>
>;

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
      /**
       * The pixels of the picture at full quality, when `plan` has fewer to make the preview
       * faster. It still takes up as much room on the screen.
       */
      readonly full?: { readonly width: number; readonly height: number };
    }
  /** Changes one layer on the spot, for what is not in the project yet. A new plan ends it. */
  | {
      readonly type: "channels";
      readonly layer: string;
      readonly channels: ChannelChanges;
      readonly fit?: RenderLayer["fit"];
      /** For what the scene of the layer works out itself. */
      readonly content?: ContentChanges;
    }
  | {
      readonly type: "file";
      readonly id: string;
      readonly file: Blob;
      /**
       * The file is a smaller copy of a video, a proxy, to decode in its place: it shows at the size
       * the video shows at, so that the picture is the same apart from its sharpness. Only for the
       * preview. Another file for the id, also the video itself, takes its place. `serial` says
       * which stand-in this is, for "stand-in-failed".
       */
      readonly standIn?: {
        readonly width: number;
        readonly height: number;
        readonly serial: number;
      };
    }
  /** What it asked for with `needs` is not there, so that waiting for it is over. */
  | { readonly type: "no-file"; readonly id: string }
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
  /**
   * The clip whose scene says where the objects of its code are, from now on, while it stands
   * still, see `scene-handles`. One at a time, null for none.
   */
  | { readonly type: "handles"; readonly layer: string | null }
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
  /**
   * This compositor is for an export. Comes before anything else. From here on it draws what `still`
   * asks for and nothing by itself, so nothing else touches the picture or the decoders.
   */
  | { readonly type: "exporting" }
  /** A picture of this moment of the plan with everything in it, or a reason why there is none. */
  | { readonly type: "still"; readonly request: number; readonly seconds: number }
  /** Starts the encoder of an export. There is one, and it gets the frames that follow. */
  | { readonly type: "encode-start"; readonly request: number; readonly config: VideoEncoderConfig }
  /** Draws a moment the way `still` does, and encodes it. */
  | ({ readonly type: "encode-frame"; readonly request: number } & FrameToEncode)
  /** Everything there is to encode has been asked for. Answered once all of it came out. */
  | { readonly type: "encode-end"; readonly request: number }
  /**
   * Everything asked for so far comes out, and the encoder goes on with the next frame, which has to
   * be a key frame. That is where an export can go on from after a crash.
   */
  | { readonly type: "encode-flush"; readonly request: number }
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
  /** Comes with a port, which reaches it from anywhere, see `compositor.ts`. */
  | { readonly type: "ready" }
  /** It needs this file. Nothing leaves the sandbox on its own, and nothing comes in by itself. */
  | { readonly type: "needs"; readonly id: string }
  | { readonly type: "cannot-decode"; readonly id: string }
  /**
   * A stand-in for a video, see "file", cannot be read: the video itself should come instead. Of the
   * stand-in with this serial, which may be one the editor sent another file in place of already.
   */
  | { readonly type: "stand-in-failed"; readonly id: string; readonly serial: number }
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
  /**
   * What the code of a scene registered and which elements its page has, in the state it came
   * from, as JSON. Only ever data: the editor reads it with `readRegistrationText`.
   */
  | {
      readonly type: "scene-objects";
      readonly layer: string;
      readonly revision: string;
      readonly registration: string;
    }
  /** What the scene of a layer registered before is not all there is any more. */
  | { readonly type: "scene-objects-unsure"; readonly layer: string; readonly revision: string }
  /**
   * Where the objects of the code of a scene are and what can be grabbed of them, on a frame of the
   * scene, in the state it came from. Only ever data: the editor reads it with `readHandles`.
   */
  | {
      readonly type: "scene-handles";
      readonly layer: string;
      readonly revision: string;
      readonly frame: number;
      readonly handles: unknown;
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
  /**
   * While playing, the preview cannot keep up because this video, by the id of its file, decodes
   * too slowly, see `SlowVideos`: a proxy would help. Once for each video. Never for a copy that
   * stands in for one.
   */
  | { readonly type: "slow-video"; readonly id: string }
  /** Scenes must stay away from there, also in the next compositor. */
  | { readonly type: "origin-retired"; readonly origin: string }
  | { readonly type: "pong"; readonly nonce: number }
  /** Something went wrong in the compositor itself, with where in its code. */
  | {
      readonly type: "failed";
      readonly name: string | undefined;
      readonly message: string | undefined;
      readonly stack: string | undefined;
    }
  | { readonly type: "frames"; readonly frames: readonly FrameTiming[] }
  /**
   * Long tasks of the compositor while recording, which the editor cannot see from its own page:
   * how long each took, and how many milliseconds before this message it started.
   */
  | {
      readonly type: "long-tasks";
      readonly tasks: readonly { readonly ms: number; readonly ago: number }[];
    }
  /**
   * New places on the timeline that reached the canvas, as how many milliseconds before this message
   * each one did. Comes always, not only while recording, and only when there were any.
   */
  | { readonly type: "painted"; readonly ago: readonly number[] }
  | { readonly type: "strip"; readonly request: number; readonly image: ImageBitmap | undefined }
  | { readonly type: "still"; readonly request: number; readonly image: ImageBitmap }
  | { readonly type: "still"; readonly request: number; readonly failure: StillFailure }
  /** What came of an `encode-` message. */
  | { readonly type: "encode-answer"; readonly request: number; readonly failure?: StillFailure }
  /** A frame came out of the encoder. They come in the order to decode them in. */
  | ({ readonly type: "encoded" } & EncodedChunk);

/** One frame of an export. Times of the file are in microseconds, as WebCodecs has them. */
export interface FrameToEncode {
  readonly index: number;
  /** Where on the timeline. */
  readonly seconds: number;
  readonly timestamp: number;
  readonly duration: number;
  readonly keyFrame: boolean;
}

/** What an encoder gave, as it can cross to another page. */
export interface EncodedChunk {
  readonly data: ArrayBuffer;
  readonly key: boolean;
  /** Microseconds. */
  readonly timestamp: number;
  readonly duration: number;
  /** Comes with the first one, and whenever the encoder changes how to decode. */
  readonly decoderConfig?: VideoDecoderConfig;
}
