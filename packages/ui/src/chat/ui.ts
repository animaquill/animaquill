import { createContext, useContext } from "react";

/**
 * What the parts of the chat ask of each other, where they are not side by side
 * (docs/design/chat-panel.md of AnimaQuill Cloud, technical design 1.3): the card of a failure
 * opens the bubble of the model, a new conversation puts the cursor in the input box. `ChatPanel`
 * gives it; outside the chat nothing happens.
 */
export interface ChatUi {
  /** Puts the cursor in the box people write new messages in. */
  focusInput(): void;
  /** Opens the bubble of the model, on the models that see pictures where asked. */
  openModels(request?: { readonly pictures?: boolean }): void;
}

const NOTHING: ChatUi = { focusInput: () => {}, openModels: () => {} };

export const ChatUiContext = createContext<ChatUi>(NOTHING);

export const useChatUi = (): ChatUi => useContext(ChatUiContext);
