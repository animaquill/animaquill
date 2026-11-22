/**
 * Signing out of the online mode (docs/design/online-offline.md of AnimaQuill Cloud, 2.1): what
 * changed here goes to the backend first, where it can; conversations that still wait here for it
 * go with signing out, once people said so, and only once the backend took the signing out: where
 * it did not, as it often cannot be reached right then, people are still signed in, and nothing of
 * theirs went. Rejects as `signOut` does.
 */
export async function signOutThen(options: {
  /** What waits here for the backend, see `AccountChats`. */
  readonly chats?: {
    flush(): Promise<void>;
    waiting(): Promise<number>;
    dropWaiting(): Promise<number>;
  };
  /** Gives the backend the AI settings that changed here, see `AccountAi.flush`. */
  readonly flush?: () => Promise<void>;
  /** Whether people sign out all the same, `count` conversations going with it. */
  readonly confirm: (count: number) => Promise<boolean>;
  readonly signOut: () => Promise<void>;
}): Promise<"signedOut" | "stayed"> {
  const { chats } = options;
  await options.flush?.();
  await chats?.flush();
  const waiting = (await chats?.waiting()) ?? 0;
  if (waiting > 0 && !(await options.confirm(waiting))) return "stayed";
  await options.signOut();
  // Signed out: what waited here for the account goes. As the page goes, which may stop it
  // halfway: what stays goes to the account the next time it signs in here.
  if (waiting > 0) await chats?.dropWaiting();
  return "signedOut";
}
