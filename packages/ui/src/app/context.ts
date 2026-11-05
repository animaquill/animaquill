import { createContext, useContext, useSyncExternalStore } from "react";
import type { ProjectState, ProjectStore } from "@animaquill/core";
import type { LayoutSnapshot } from "../workbench/layout.ts";
import type { SessionSnapshot } from "../workbench/session.ts";
import type { Workbench } from "../workbench/workbench.ts";

export const WorkbenchContext = createContext<Workbench | null>(null);

export function useWorkbench(): Workbench {
  const workbench = useContext(WorkbenchContext);
  if (!workbench) throw new Error("useWorkbench needs a WorkbenchContext above it");
  return workbench;
}

export function useSession(): SessionSnapshot {
  const { session } = useWorkbench();
  return useSyncExternalStore(session.subscribe, session.getSnapshot);
}

const noStore = () => () => {};
const noState = () => undefined;

/** The open project, updated with every change. */
export function useProject(store: ProjectStore | undefined): ProjectState | undefined {
  return useSyncExternalStore(store?.subscribe ?? noStore, store?.getState ?? noState);
}

export function useLayout(): LayoutSnapshot {
  const { layout } = useWorkbench();
  return useSyncExternalStore(layout.subscribe, layout.getSnapshot);
}
