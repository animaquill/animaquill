// Adapted from pi-web (https://github.com/agegr/pi-web), hooks/useStreamingSelector.ts, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.
import { NO_LIVE, type LiveAnswer, type LiveStore } from "@animaquill/agent";
import { useLayoutEffect, useState } from "react";

/**
 * One value of the answer on its way: the component draws again only when that value changes.
 * `select` must stay the same function (one of the module).
 *
 * A plain state update rather than `useSyncExternalStore`: that one draws every piece on its own,
 * while state updates let React take together the pieces that land before it draws.
 */
export function useLive<T>(store: LiveStore | undefined, select: (state: LiveAnswer) => T): T {
  const [value, setValue] = useState(() => select(store?.getState() ?? NO_LIVE));
  useLayoutEffect(() => {
    const update = () => setValue(() => select(store?.getState() ?? NO_LIVE));
    // A piece may have landed between this render and the subscription.
    update();
    return store?.subscribe(update);
  }, [store, select]);
  return value;
}

export const liveText = (state: LiveAnswer): string => state.text;
export const liveThinking = (state: LiveAnswer): string => state.thinking;
export const liveThinkingSince = (state: LiveAnswer): number | undefined => state.thinkingSince;
/** What the model does now, as far as its words tell. */
export const livePhase = (state: LiveAnswer): "waiting" | "thinking" | "writing" =>
  state.text !== "" ? "writing" : state.thinkingSince !== undefined ? "thinking" : "waiting";
