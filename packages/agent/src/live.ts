// Adapted from pi-web (https://github.com/agegr/pi-web), lib/streaming-message.ts, commit 57cea50.
// Copyright (c) 2026 agegr. MIT License; see LICENSES/pi-web.txt.

/**
 * What the answer on its way says so far, kept outside the snapshot of a conversation: a piece of
 * text comes many times a second, and only what shows it should draw again, not the whole chat.
 * The snapshot changes only when an answer or a tool begins or ends.
 */
export interface LiveAnswer {
  /** What AI wrote of the answer on its way. */
  readonly text: string;
  /** What it said of its thinking for this answer so far, where its service gives that. */
  readonly thinking: string;
  /** When the thinking of this answer began, while it goes on. */
  readonly thinkingSince: number | undefined;
  /** When anything last came from the service or the tools, to tell when it went quiet. */
  readonly heardAt: number;
}

export type LiveAction =
  | { readonly type: "start"; readonly at: number }
  | { readonly type: "text"; readonly delta: string; readonly at: number }
  | { readonly type: "thinking"; readonly delta: string; readonly at: number }
  /** Something else came: a tool began or ended, an answer ended. The words start again. */
  | { readonly type: "heard"; readonly at: number; readonly clear?: boolean };

export const NO_LIVE: LiveAnswer = { text: "", thinking: "", thinkingSince: undefined, heardAt: 0 };

export function liveReducer(state: LiveAnswer, action: LiveAction): LiveAnswer {
  switch (action.type) {
    case "start":
      return { ...NO_LIVE, heardAt: action.at };
    case "text":
      return {
        ...state,
        text: state.text + action.delta,
        thinkingSince: undefined,
        heardAt: action.at,
      };
    case "thinking":
      return {
        ...state,
        thinking: state.thinking + action.delta,
        thinkingSince: state.thinkingSince ?? action.at,
        heardAt: action.at,
      };
    case "heard":
      return action.clear ? { ...NO_LIVE, heardAt: action.at } : { ...state, heardAt: action.at };
  }
}

/**
 * The answer on its way, outside React: a piece re-renders only what subscribes to the part of it
 * that it shows. Listeners run right away in `dispatch`.
 */
export interface LiveStore {
  getState(): LiveAnswer;
  dispatch(action: LiveAction): void;
  subscribe(listener: () => void): () => void;
}

export function createLiveStore(): LiveStore {
  let state = NO_LIVE;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = liveReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
