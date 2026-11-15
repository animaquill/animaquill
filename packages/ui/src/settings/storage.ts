import { readEntry } from "@animaquill/agent";
import type { ChatImageStore, ChatStore } from "@animaquill/host";

/** How many conversations this browser keeps, and how much they take, in bytes. */
export interface ChatsUsage {
  readonly all: { readonly count: number; readonly bytes: number };
  /** The pictures of conversations and drafts kept here. */
  readonly images: { readonly count: number; readonly bytes: number };
  /** Those of projects that are not of the platform: only here, nowhere else. */
  readonly local: { readonly count: number; readonly projects: number };
}

/** What reading and clearing the conversations needs of the workbench. */
export interface ChatsPlace {
  readonly chatStore: ChatStore | undefined;
  readonly chatImages?: ChatImageStore | undefined;
  /** The projects of the platform: a link is what makes a project one. */
  readonly cloud?: { linkOf(project: string): Promise<unknown> } | undefined;
  readonly chat: {
    readonly projectKey: string | undefined;
    readonly running: boolean;
    newConversation(): void;
    reloadList(): Promise<void>;
    /** The pictures of the drafts this window has open, which stay. */
    readonly attachments?: { draftImages(): ReadonlySet<string> };
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
  const kept = (await place.chatImages?.keys().catch(() => [])) ?? [];
  const images = {
    count: kept.length,
    bytes: kept.reduce((sum, each) => sum + each.bytes, 0),
  };
  return { all: { count, bytes }, images, local: { count: local, projects } };
}

/**
 * Takes away the pictures that no conversation kept here has, nor a draft this window has open.
 * A draft of another window can lose its pictures, which it then says when it is sent.
 */
export async function clearUnusedImages(place: ChatsPlace): Promise<number> {
  const store = place.chatStore;
  const images = place.chatImages;
  if (!store?.usage || !images) return 0;
  const used = new Set(place.chat.attachments?.draftImages() ?? []);
  for (const { project } of await store.usage()) {
    for (const { id } of await store.list(project)) {
      const chat = await store.load(project, id);
      for (const value of chat?.entries ?? []) {
        const entry = readEntry(value);
        if (entry?.role === "user") for (const image of entry.images ?? []) used.add(image.image);
      }
    }
  }
  const gone = (await images.keys()).map(({ image }) => image).filter((image) => !used.has(image));
  await images.delete(gone);
  return gone.length;
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
  // Their pictures go with them, unless something else still has them.
  await clearUnusedImages(place);
  return { cleared, kept };
}
