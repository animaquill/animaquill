import type { RenderPlan } from "@animaquill/core";

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

/** From the editor to the compositor. */
export type ToCompositor =
  | { readonly type: "plan"; readonly plan: RenderPlan }
  | { readonly type: "file"; readonly id: string; readonly file: Blob }
  /** A jump is somebody moving the playhead, as opposed to time carrying it along while playing. */
  | { readonly type: "seek"; readonly seconds: number; readonly jump: boolean }
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
  | { readonly type: "frames"; readonly frames: readonly FrameTiming[] }
  | { readonly type: "strip"; readonly request: number; readonly image: ImageBitmap | undefined };
