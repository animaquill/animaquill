import { createContext, useContext, useSyncExternalStore } from "react";
import type { TabStrips } from "./strips.ts";

export const StripsContext = createContext<TabStrips | null>(null);

/** How the groups show their tabs, updated with every change. */
export function useStrips(): TabStrips {
  const strips = useContext(StripsContext);
  if (!strips) throw new Error("useStrips needs a StripsContext above it");
  useSyncExternalStore(strips.subscribe, strips.getSnapshot);
  return strips;
}
