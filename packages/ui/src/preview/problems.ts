import { entryOf, type ClipState, type ProjectState } from "@animaquill/core";
import type { SceneStatus } from "@animaquill/render";
import type { SceneProblem } from "@animaquill/scene";
import type { TFunction } from "i18next";
import type zhCN from "../i18n/zh-CN.json";

/** What people call a clip with a scene: what they named it, or else what the scene is called. */
export function sceneClipName(
  clip: ClipState | undefined,
  state: ProjectState | undefined,
  t: TFunction,
): string {
  const scene = clip?.source.kind === "scene" ? (clip.source.scene as string) : undefined;
  const known = scene === undefined ? undefined : entryOf(state?.scenes, scene);
  return clip?.name ?? known?.name ?? t("timeline.kind.scene");
}

const fieldsOf = ({ message = "", file = "", line, target = "", code = "" }: SceneProblem) => ({
  message,
  file,
  line: line ?? 0,
  target,
  code,
  // Text from a project is text, whatever it looks like.
  interpolation: { escapeValue: false },
});

/** What a problem of a scene says in words. A code nobody knows yet shows as it is. */
export function describeProblem(t: TFunction, problem: SceneProblem): string {
  const fields = fieldsOf(problem);
  const { kind, code, line } = problem;
  if (kind === "error") {
    return line === undefined
      ? t("scene.problems.error", fields)
      : t("scene.problems.errorAt", fields);
  }
  if (kind === "rejection") return t("scene.problems.rejection", fields);
  if (kind === "resource") return t("scene.problems.resource", fields);
  if (kind === "blocked") return t("scene.problems.blocked", fields);
  return t(`scene.problems.codes.${code}`, {
    ...fields,
    defaultValue: t("scene.problems.other", fields),
  });
}

type StoppedScene = keyof typeof zhCN.preview.stoppedScene;

const RUNTIME_FAILURES = new Set(["missing-entry", "runtime-load", "frame-out-of-range"]);

/** What people should know about a scene that does not run. */
export function describeStatus(
  t: TFunction,
  name: string,
  { state, reason, message = "" }: SceneStatus,
): string {
  if (state === "too-new") return t("preview.tooNew", { name });
  if (state === "retrying") return t("preview.retrying", { name });
  // What a scene says about itself can be a code of the runtime, which has words of its own.
  const said = reason === "failed" && RUNTIME_FAILURES.has(message) ? message : reason;
  return t(`preview.stoppedScene.${(said ?? "silent") as StoppedScene}`, {
    name,
    message,
    interpolation: { escapeValue: false },
  });
}
