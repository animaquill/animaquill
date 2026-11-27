import type { Conversation, ConversationSnapshot } from "@animaquill/agent";
import { useSyncExternalStore } from "react";
import { useWorkbench } from "../app/context.ts";
import type { ChatSnapshot } from "./session.ts";

/**
 * The conversation the chat shows, as its parts read it: which one, what was said in it and the
 * task that runs, what is queued, the switch "先出方案". Only one conversation runs in a window for
 * now; once several do (docs/design/ai-teamwork.md of AnimaQuill Cloud), this is where the one
 * shown is chosen, and nothing that reads it changes.
 */
export interface ShownChat {
  readonly id: string | undefined;
  readonly conversation: Conversation | undefined;
  readonly talk: ConversationSnapshot;
  readonly running: boolean;
  readonly queued: ChatSnapshot["queued"];
  readonly planFirst: boolean;
  readonly hold: ChatSnapshot["hold"];
}

const NO_CONVERSATION: ConversationSnapshot = { entries: [], running: undefined, last: undefined };
const noop = () => () => {};
const none = () => NO_CONVERSATION;

export function useShownChat(): ShownChat {
  const { chat } = useWorkbench();
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const { conversation } = snapshot;
  const talk = useSyncExternalStore(
    conversation?.subscribe ?? noop,
    conversation?.getSnapshot ?? none,
  );
  return {
    id: snapshot.id,
    conversation,
    talk,
    running: talk.running !== undefined,
    queued: snapshot.queued,
    planFirst: snapshot.planFirst,
    hold: snapshot.hold,
  };
}
