import { createContext, useContext, useSyncExternalStore } from "react";
import type { LayoutSnapshot } from "../workbench/layout.ts";
import type { Workbench } from "../workbench/workbench.ts";

export const WorkbenchContext = createContext<Workbench | null>(null);

export function useWorkbench(): Workbench {
  const workbench = useContext(WorkbenchContext);
  if (!workbench) throw new Error("useWorkbench needs a WorkbenchContext above it");
  return workbench;
}

export function useLayout(): LayoutSnapshot {
  const { layout } = useWorkbench();
  return useSyncExternalStore(layout.subscribe, layout.getSnapshot);
}
