import type { RenderPlan } from "@animaquill/core";

/** From the editor to the compositor. */
export type ToCompositor =
  | { readonly type: "plan"; readonly plan: RenderPlan }
  | { readonly type: "file"; readonly id: string; readonly file: Blob }
  | { readonly type: "seek"; readonly seconds: number };

/** From the compositor to the editor. */
export type FromCompositor =
  | { readonly type: "ready" }
  /** It needs this file. Nothing leaves the sandbox on its own, and nothing comes in by itself. */
  | { readonly type: "needs"; readonly id: string }
  | { readonly type: "cannot-decode"; readonly id: string };
