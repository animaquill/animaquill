import type { ChatStore } from "@animaquill/host";

/** How many conversations this browser keeps, and how much they take, in bytes. */
export interface ChatsUsage {
  readonly all: { readonly count: number; readonly bytes: number };
  /** Those of projects that are not of the platform: only here, nowhere else. */
  readonly local: { readonly count: number; readonly projects: number };
}

/** What reading and clearing the conversations needs of the workbench. */
export interface ChatsPlace {
  readonly chatStore: ChatStore | undefined;
  /** The projects of the platform: a link is what makes a project one. */
  readonly cloud?: { linkOf(project: string): Promise<unknown> } | undefined;
  readonly chat: {
    readonly projectKey: string | undefined;
    readonly running: boolean;
    newConversation(): void;
    reloadList(): Promise<void>;
  };
}

/**
 * Whether the conversations of a project are of a project of the platform, which go with the
 * account and come back: where that cannot be told, they count as such, and stay.
 */
async function isOfPlatform(place: ChatsPlace, project: string): Promise<boolean> {
  if (!place.cloud) return false;
  try {
    return (await place.cloud.linkOf(project)) !== undefined;
  } catch {
    return true;
  }
}

export async function usageOfChats(place: ChatsPlace): Promise<ChatsUsage> {
  const store = place.chatStore;
  if (!store?.usage) throw new Error("This browser cannot say what its conversations take");
  const usage = await store.usage();
  let count = 0;
  let bytes = 0;
  let local = 0;
  let projects = 0;
  for (const each of usage) {
    count += each.count;
    bytes += each.bytes;
    if (await isOfPlatform(place, each.project)) continue;
    local += each.count;
    projects += 1;
  }
  return { all: { count, bytes }, local: { count: local, projects } };
}

/**
 * Takes away the conversations of every project that is not of the platform. Those of the project
 * whose conversation is running in this window stay, and are counted as `kept`; the window's chat
 * starts a new conversation where its project's went.
 */
export async function clearLocalChats(
  place: ChatsPlace,
): Promise<{ readonly cleared: number; readonly kept: number }> {
  const store = place.chatStore;
  if (!store?.usage) return { cleared: 0, kept: 0 };
  let cleared = 0;
  let kept = 0;
  const here = place.chat.projectKey;
  for (const each of await store.usage()) {
    if (await isOfPlatform(place, each.project)) continue;
    if (each.project === here && place.chat.running) {
      kept += each.count;
      continue;
    }
    await store.forget(each.project);
    cleared += each.count;
    if (each.project === here) {
      place.chat.newConversation();
      await place.chat.reloadList();
    }
  }
  return { cleared, kept };
}
