import { useMemo, useSyncExternalStore } from "react";
import { useWorkbench } from "../../app/context.ts";
import type { RunSummary } from "../session.ts";

/** How each conversation the window has stands, by its id: what runs, waits or was not seen. */
export function useRuns(): ReadonlyMap<string, RunSummary> {
  const { chat } = useWorkbench();
  const runs = useSyncExternalStore(chat.subscribe, () => chat.getSnapshot().runs);
  return useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
}

/** Whether a conversation has something for people: it waits for them, or ended unseen. */
export const callsFor = (run: RunSummary | undefined): boolean =>
  run !== undefined && (run.state === "waiting" || (run.unseen && run.state !== "running"));
