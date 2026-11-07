import { entryOf, type ClipState, type ProjectState } from "@animaquill/core";
import type { StillFailure } from "@animaquill/render";
import type { TFunction } from "i18next";
import type { SoundFailure } from "../media/sounds.ts";
import { describeStatus, sceneClipName } from "../preview/problems.ts";
import type { TimelineEditor } from "../timeline/editor.ts";

/** Why a moment did not make it into the file: a picture, or a sound that code did not make. */
export type ExportFailure =
  | StillFailure
  | { readonly reason: "sound-not-made"; readonly layer: string; readonly why: SoundFailure };

/** What people call what a failure is about. */
function nameOf(
  t: TFunction,
  clip: ClipState | undefined,
  state: ProjectState,
  file: string | undefined,
): string {
  const assets = file === undefined ? [] : Object.values(state.assets ?? {});
  const asset = assets.find(({ hash }) => hash === file);
  if (clip?.source.kind === "sound") {
    const sound = entryOf(state.sounds, clip.source.sound as string);
    return clip.name ?? sound?.name ?? t("timeline.kind.sound");
  }
  return clip?.name ?? asset?.name ?? sceneClipName(clip, state, t);
}

/** What people get told about why there is no picture. */
export function describeFailure(
  t: TFunction,
  failure: ExportFailure,
  state: ProjectState,
  timeline: Pick<TimelineEditor, "model">,
): string {
  const plain = { interpolation: { escapeValue: false } };
  if (failure.reason === "compositor") return t("export.failure.compositor");
  if (failure.reason === "encoder") {
    return t("export.failure.encoder", { message: failure.message, ...plain });
  }
  if (failure.reason === "failed") {
    return t("export.failure.other", { message: failure.message, ...plain });
  }
  const clip = timeline.model?.boxes.get(failure.layer)?.clip;
  const file = "file" in failure ? failure.file : undefined;
  const name = nameOf(t, clip, state, file);
  if (failure.reason === "missing-file") {
    return t("export.failure.missingFile", { name, ...plain });
  }
  if (failure.reason === "cannot-decode") {
    return t("export.failure.cannotDecode", { name, ...plain });
  }
  if (failure.reason === "sound-not-made") {
    return t(`sound.failed.${failure.why}`, { name, ...plain });
  }
  if (failure.reason === "scene-frame") {
    return t("export.failure.sceneFrame", { name, wanted: failure.wanted, ...plain });
  }
  const { status } = failure;
  if (status.state === "unsupported") return t("export.failure.sceneUnsupported");
  if (status.state === "off") return t("export.failure.sceneOff");
  if (status.state === "too-new") return t("preview.tooNew", { name, ...plain });
  if (status.state === "stopped") return describeStatus(t, name, status);
  return t("export.failure.sceneClosed", { name, ...plain });
}
