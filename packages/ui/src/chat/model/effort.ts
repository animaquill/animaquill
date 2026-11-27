import type { ReasoningLevel } from "@animaquill/agent";
import { REASONING, usePack as packFor } from "@animaquill/tools";
import { useSyncExternalStore } from "react";
import { useWorkbench } from "../../app/context.ts";

/** How hard the model of the conversation reasons, and what it can. */
export interface Effort {
  readonly model: string;
  /** The steps the model takes, in order; none where it does not reason. */
  readonly levels: readonly ReasoningLevel[];
  /** What this conversation chose; nothing is "自动". */
  readonly chosen: ReasoningLevel | undefined;
  /** What "自动" is: the default people set for the model, else what its pack says. */
  readonly auto: ReasoningLevel | undefined;
  /** The default people set for the model, where they did. */
  readonly starred: ReasoningLevel | undefined;
}

/** How hard the model of the conversation open reasons; nothing where it cannot or is not there. */
export function useEffort(): Effort | undefined {
  const { ai, chat } = useWorkbench();
  const settings = useSyncExternalStore(ai.subscribe, ai.getSnapshot);
  const snapshot = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  const now = chat.modelNow();
  const model = now?.ref.model ?? "";
  // What the pack of the model says, which "自动" comes to where people set no default.
  const byPack = packFor(chat.choiceFor(model).pack, model).call.reasoning;
  if (!now || now.state !== "ok") return undefined;
  const info = ai.modelOf(now.ref.service, model);
  if (info?.reasoning === false) return undefined;
  const starred = settings.reasoningFor?.[model];
  return {
    model,
    levels: info?.levels ?? REASONING,
    chosen: snapshot.reasoning,
    auto: starred ?? byPack,
    starred,
  };
}
