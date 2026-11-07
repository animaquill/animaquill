import {
  entryOf,
  sceneFilesOf,
  type ProjectState,
  type RenderPlan,
  type SceneSource,
} from "@animaquill/core";
import type { ToCompositor } from "@animaquill/render";

type SceneContent = Extract<ToCompositor, { type: "scene-files" }>;

/** Whether a plan shows a scene in this state of the project. */
function sourceIn(plan: RenderPlan | undefined, scene: string, revision: string) {
  for (const { source } of plan?.layers ?? []) {
    if (source.kind === "scene" && source.scene === scene && source.revision === revision) {
      return source;
    }
  }
  return undefined;
}

/** A scene only gets what the plan says is its own, however it asks. */
export async function sceneContent(
  state: ProjectState,
  plan: RenderPlan | undefined,
  { scene, revision }: Pick<SceneSource, "scene" | "revision">,
  mediaOf: (hash: string) => Promise<Blob | undefined>,
): Promise<SceneContent | undefined> {
  const source = sourceIn(plan, scene, revision);
  if (!source) return undefined;
  const files = new Map(
    sceneFilesOf(state, scene).map((path) => [path, new Blob([entryOf(state.files, path) ?? ""])]),
  );
  const assets = new Map<string, Blob>();
  await Promise.all(
    source.assets.map(async ({ id, file }) => {
      // The scene says so itself when it asks for one that is not there, and it can run without it.
      const media = await mediaOf(file).catch(() => undefined);
      if (media) assets.set(id, media);
    }),
  );
  return { type: "scene-files", scene, revision, files, assets };
}
