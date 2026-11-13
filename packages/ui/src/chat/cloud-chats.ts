import {
  ChatNewer,
  type AccountAccess,
  type ChatStore,
  type ChatSyncAccess,
  type CloudLinks,
  type SavedChat,
  type SavedChatSummary,
} from "@animaquill/host";

/**
 * The conversations of a window, those of projects of the platform going with the account
 * (docs/design/chat-and-models.md of AnimaQuill Cloud, 5.1, 5.4), see `ChatSyncAccess`; those of
 * other projects stay in this browser only, as before.
 *
 * The browser keeps a copy of each (`SavedChat.synced`: the revision the account has, as last
 * written or read here), which is what shows while the platform cannot be reached, and what goes
 * once it can. A conversation is written whole, over the revision it was read at: where another
 * device wrote it since, the account's is taken here, and saving rejects with a `ChatNewer`, for
 * the chat to show the account's. One that went from the account elsewhere goes from here too, as
 * the list is read; one that was never on the account goes as it is read.
 */

export interface CloudChatsOptions {
  readonly local: ChatStore;
  readonly remote: ChatSyncAccess;
  readonly account: AccountAccess;
  readonly links: CloudLinks;
  /** The platform of the links, see `CloudAccess.platform`. */
  readonly platform: string;
  /**
   * The account had another version of a conversation than this browser, which had changed it too:
   * this browser's went into a new conversation, `copy`, and the account's took its place.
   */
  readonly copied?: (title: string, copy: string) => void;
}

/** Whether a conversation has what the account does not: changed here since it last went, or never went. */
export const isUnsent = (chat: SavedChat): boolean =>
  chat.synced === undefined || chat.syncedAt === undefined || chat.updatedAt > chat.syncedAt;

const copyId = () =>
  `chat-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36)}`;

/**
 * Rules, each with a test in cloud-chats.test.ts:
 *
 * - Where the account's version of a conversation takes the place of one changed here (another
 *   device wrote it since), this browser's is kept first as a new conversation, "《X》在这台设备上的副本", which goes to the account in turn, and people are told.
 * - Signing out lets go only of conversations that are as the account has them; the others stay,
 *   for their link says whose project they are of, and go once that account is signed in again.
 */
export class CloudChats implements ChatStore {
  readonly #options: CloudChatsOptions;
  /** Writes of each conversation, one after the other. */
  readonly #writing = new Map<string, Promise<unknown>>();

  constructor(options: CloudChatsOptions) {
    this.#options = options;
  }

  /** The project of the platform a project of this browser is, while somebody is signed in. */
  async #cloudOf(key: string): Promise<string | undefined> {
    const snapshot = this.#options.account.getSnapshot();
    if (snapshot.status !== "signedIn") return undefined;
    const link = await this.#options.links.get(key).catch(() => undefined);
    if (!link || link.platform !== this.#options.platform || link.creating) return undefined;
    // Of the person's own projects only, as far as the link knows whose it is.
    if (link.owner !== undefined && snapshot.id !== undefined && link.owner !== snapshot.id)
      return undefined;
    return link.project;
  }

  async list(project: string): Promise<readonly SavedChatSummary[]> {
    const { local, remote } = this.#options;
    const here = await local.list(project);
    const cloud = await this.#cloudOf(project);
    if (cloud === undefined) return here;
    let there;
    try {
      there = await remote.list(cloud);
    } catch (error) {
      console.warn("The conversations of the account could not be read", error);
      return here;
    }
    const byId = new Map(there.map((each) => [each.summary.id, each]));
    const kept: SavedChatSummary[] = [];
    for (const summary of here) {
      const theirs = byId.get(summary.id);
      const chat = await local.load(project, summary.id).catch(() => undefined);
      if (!theirs) {
        // On the account before, and gone from it since: gone here too.
        if (chat?.synced !== undefined) {
          await local.remove(project, summary.id).catch(() => {});
          continue;
        }
        // Never on the account: it goes now.
        if (chat) void this.#give(cloud, chat).catch(() => {});
        kept.push(summary);
        continue;
      }
      // Changed here since the account had it, as while offline: it goes.
      if (chat && chat.synced === theirs.revision && isUnsent(chat))
        void this.#give(cloud, chat).catch(() => {});
    }
    const merged = [
      ...there.map((each) => ({ ...each.summary, project }) as SavedChatSummary),
      ...kept,
    ];
    return merged.toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(project: string, id: string): Promise<SavedChat | undefined> {
    const { local, remote } = this.#options;
    const here = await local.load(project, id).catch(() => undefined);
    const cloud = await this.#cloudOf(project);
    if (cloud === undefined) return here;
    try {
      const there = await remote.load(cloud, id);
      if (!there) return here;
      if (here && here.synced === there.revision) {
        // What this browser changed and the account does not have yet stays, to go.
        if (isUnsent(here)) void this.#give(cloud, here).catch(() => {});
        return here;
      }
      return await this.#take(here, there, project);
    } catch (error) {
      console.warn("A conversation of the account could not be read", error);
      return here;
    }
  }

  async save(chat: SavedChat): Promise<void> {
    const { local } = this.#options;
    const before = await local.load(chat.project, chat.id).catch(() => undefined);
    const saved: SavedChat = {
      ...chat,
      ...(before?.synced !== undefined && { synced: before.synced }),
      ...(before?.syncedAt !== undefined && { syncedAt: before.syncedAt }),
    };
    await local.save(saved);
    const cloud = await this.#cloudOf(chat.project);
    if (cloud === undefined) return;
    await this.#give(cloud, saved);
  }

  /** Writes a conversation to the account, after the writes of it before. */
  #give(cloud: string, chat: SavedChat): Promise<void> {
    const key = `${chat.project}\n${chat.id}`;
    const next = (this.#writing.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const { local, remote } = this.#options;
        // The revision as it is now: an earlier write may have moved it on.
        const now = await local.load(chat.project, chat.id).catch(() => undefined);
        const base = now?.synced ?? null;
        try {
          const revision = await remote.save(cloud, chat, base);
          if (revision === undefined) return;
          const latest = await local.load(chat.project, chat.id).catch(() => undefined);
          await local.save({ ...(latest ?? chat), synced: revision, syncedAt: chat.updatedAt });
        } catch (error) {
          if (!(error instanceof ChatNewer)) {
            // It stays here, and goes the next time.
            console.warn("A conversation could not go to the account", error);
            return;
          }
          const theirs = await remote.load(cloud, chat.id).catch(() => undefined);
          const latest = await local.load(chat.project, chat.id).catch(() => undefined);
          if (theirs) await this.#take(latest ?? chat, theirs, chat.project);
          throw error;
        }
      });
    this.#writing.set(key, next);
    return next;
  }

  /**
   * The account's version of a conversation, in place of this browser's: where this browser's has
   * what the account does not, it is kept first, as a new conversation.
   */
  async #take(
    here: SavedChat | undefined,
    there: { readonly revision: number; readonly chat: SavedChat },
    project: string,
  ): Promise<SavedChat> {
    const { local } = this.#options;
    if (here && isUnsent(here)) {
      const title = `《${here.title}》在这台设备上的副本`;
      const {
        synced: _synced,
        syncedAt: _syncedAt,
        titleBy: _titleBy,
        forkedFrom: _forkedFrom,
        ...rest
      } = here;
      const copy: SavedChat = { ...rest, id: copyId(), title, titleBy: "user" };
      // Kept before anything takes its place: if this fails, nothing is taken.
      await local.save(copy);
      this.#options.copied?.(here.title, title);
      const cloud = await this.#cloudOf(project);
      if (cloud !== undefined) void this.#give(cloud, copy).catch(() => {});
    }
    const chat: SavedChat = {
      ...there.chat,
      project,
      synced: there.revision,
      syncedAt: there.chat.updatedAt,
    };
    await local.save(chat);
    return chat;
  }

  async remove(project: string, id: string): Promise<void> {
    await this.#options.local.remove(project, id);
    const cloud = await this.#cloudOf(project);
    if (cloud !== undefined) await this.#options.remote.remove(cloud, id);
  }

  async forget(project: string): Promise<void> {
    await this.#options.local.forget(project);
  }

  /**
   * Lets go of what this browser keeps of the account's conversations, as people sign out: those
   * as the account has them are gone from here; one changed here that the account does not have yet
   * stays, as it is nowhere else, and goes once the account is signed in here again.
   */
  async beforeSignOut(): Promise<void> {
    await Promise.allSettled(this.#writing.values());
    const { local, links, platform } = this.#options;
    const all = await links.list().catch(() => []);
    for (const link of all) {
      if (link.platform !== platform) continue;
      for (const summary of await local.list(link.key).catch(() => [])) {
        const chat = await local.load(link.key, summary.id).catch(() => undefined);
        // As the account has it: it is there. Otherwise it stays, to go the next time.
        if (chat && !isUnsent(chat)) await local.remove(link.key, summary.id).catch(() => {});
      }
    }
  }
}
