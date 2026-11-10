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

/**
 * How many times the panel around this has come into view: one more each time it is opened again
 * after it was hidden behind another tab or closed away. What waits for the panel to be opened
 * again, such as an order that should not move under the mouse, goes by it.
 */
export const PanelShownContext = createContext(0);

export const usePanelShown = (): number => useContext(PanelShownContext);

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
