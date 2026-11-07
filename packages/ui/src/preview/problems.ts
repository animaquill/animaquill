import { entryOf, type ClipState, type ProjectState } from "@animaquill/core";
import type { SceneProblem } from "@animaquill/scene";
import type { TFunction } from "i18next";

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
