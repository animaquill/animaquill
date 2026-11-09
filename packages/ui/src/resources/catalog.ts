import { missingIn, type MissingResource, type UsedResource } from "@animaquill/core";
import type { TransitionRef } from "@animaquill/schema";
import type { TFunction } from "i18next";
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useProject, useSession, useWorkbench } from "../app/context.ts";
import { builtInEffects, type EffectItem } from "./effects.ts";
import { projectResources, type ProjectItem } from "./project-resources.ts";
import type { Resource } from "./resources.ts";
import { builtInTransitions, type TransitionItem } from "./transitions.ts";

/** What the explorer and the pages of resources know of each resource, wherever it is from. */
export type ExplorerItem =
  | { readonly kind: "project"; readonly item: ProjectItem }
  | { readonly kind: "transition"; readonly item: TransitionItem }
  | { readonly kind: "effect"; readonly item: EffectItem }
  /** Something that clips use, which is not there. */
  | { readonly kind: "missing"; readonly missing: MissingResource };

export const as = <T, D>(resource: Resource<T>, data: D): Resource<D> => ({ ...resource, data });

/** What a reference to a transition says it is, as people read it. */
const refName = (ref: TransitionRef): string =>
  ref.type ?? ref.transition ?? `${ref.library ?? ""}/${ref.resource ?? ""}`;

/** Something that is missing, as a resource of the list. */
function missingResource(t: TFunction, missing: MissingResource): Resource<ExplorerItem> {
  const source = { kind: "project" } as const;
  const data: ExplorerItem = { kind: "missing", missing };
  const base = { source, tags: [] as readonly string[], data };
  switch (missing.kind) {
    case "asset":
    case "scene":
    case "sound":
      return {
        ...base,
        id: `missing:${missing.kind}:${missing.id}`,
        type: missing.kind === "asset" ? "file" : missing.kind,
        name: (t as (key: string, options: object) => string)(
          `explorer.missingName.${missing.kind}`,
          { id: missing.id },
        ),
        keywords: [missing.id],
      };
    case "library":
      return {
        ...base,
        id: `missing:library:${missing.library}:${missing.item}`,
        type: "library",
        name: missing.item.slice(missing.item.lastIndexOf("/") + 1),
        keywords: [missing.library, missing.item],
      };
    case "effect":
      return { ...base, id: `missing:effect:${missing.type}`, type: "effect", name: missing.type };
    case "transition":
      return {
        ...base,
        id: `missing:transition:${missing.use}:${refName(missing.ref)}`,
        type: `transition.${missing.use}`,
        name: refName(missing.ref),
      };
  }
}

/** What a resource is, for where it is used. */
export function usedOf(data: ExplorerItem): UsedResource | undefined {
  switch (data.kind) {
    case "project":
      return { kind: data.item.kind, id: data.item.id };
    case "transition":
      return { kind: "transition", use: data.item.use, ref: data.item.pick.name };
    case "effect":
      return { kind: "effect", type: data.item.type };
    case "missing":
      return undefined;
  }
}

export interface ResourceCatalog {
  readonly transitions: readonly Resource<ExplorerItem>[];
  readonly effects: readonly Resource<ExplorerItem>[];
  /** What the project has itself. */
  readonly own: readonly Resource<ExplorerItem>[];
  /** Assets whose file is missing, then what clips use that is not there at all. */
  readonly gone: readonly Resource<ExplorerItem>[];
  readonly byId: ReadonlyMap<string, Resource<ExplorerItem>>;
}

/**
 * Every resource there is for the open project: built in, its own, and what it misses. Each list
 * stays the same object for as long as what it comes from does. Finding what is missing goes
 * through every clip, which takes a while in a large project: without `missing` it is left out.
 */
export function useResourceCatalog({ missing: withMissing = true } = {}): ResourceCatalog {
  const { missingFiles } = useWorkbench();
  const { t } = useTranslation();
  const { store } = useSession();
  const project = useProject(store);
  const missing = useSyncExternalStore(missingFiles.subscribe, missingFiles.getSnapshot);
  const transitions = useMemo(
    () =>
      builtInTransitions(t).map((resource) =>
        as(resource, { kind: "transition", item: resource.data } as ExplorerItem),
      ),
    [t],
  );
  const effects = useMemo(
    () =>
      builtInEffects(t).map((resource) =>
        as(resource, { kind: "effect", item: resource.data } as ExplorerItem),
      ),
    [t],
  );
  const own = useMemo(
    () =>
      project
        ? projectResources(project, project.manifest.id).map((resource) =>
            as(resource, { kind: "project", item: resource.data } as ExplorerItem),
          )
        : [],
    [project],
  );
  const references = useMemo(
    () => (project && withMissing ? missingIn(project) : []),
    [project, withMissing],
  );
  const gone = useMemo(
    () => [
      ...own.filter(
        ({ data }) =>
          data.kind === "project" && data.item.kind === "asset" && missing.has(data.item.id),
      ),
      ...references.map((each) => missingResource(t, each)),
    ],
    [own, missing, references, t],
  );
  const byId = useMemo(
    () =>
      new Map(
        [...transitions, ...effects, ...own, ...gone].map((resource) => [resource.id, resource]),
      ),
    [transitions, effects, own, gone],
  );
  return { transitions, effects, own, gone, byId };
}
