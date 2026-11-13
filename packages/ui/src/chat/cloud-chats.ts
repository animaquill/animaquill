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
}

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
      if (chat && chat.synced === theirs.revision && chat.updatedAt > theirs.summary.updatedAt)
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
      // What this browser changed and the account does not have yet stays, to go.
      if (here && here.synced === there.revision && here.updatedAt > there.chat.updatedAt)
        return here;
      const chat: SavedChat = { ...there.chat, project, synced: there.revision };
      await local.save(chat).catch(() => {});
      return chat;
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
          await local.save({ ...(latest ?? chat), synced: revision });
        } catch (error) {
          if (!(error instanceof ChatNewer)) {
            // It stays here, and goes the next time.
            console.warn("A conversation could not go to the account", error);
            return;
          }
          const theirs = await remote.load(cloud, chat.id).catch(() => undefined);
          if (theirs)
            await local.save({ ...theirs.chat, project: chat.project, synced: theirs.revision });
          throw error;
        }
      });
    this.#writing.set(key, next);
    return next;
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
   * Lets go of what this browser keeps of the account's conversations, as people sign out: what
   * the account has is gone from here; what it does not have yet stays, as it is nowhere else.
   */
  async beforeSignOut(): Promise<void> {
    await Promise.allSettled(this.#writing.values());
    const { local, links, platform } = this.#options;
    const all = await links.list().catch(() => []);
    for (const link of all) {
      if (link.platform !== platform) continue;
      for (const summary of await local.list(link.key).catch(() => [])) {
        const chat = await local.load(link.key, summary.id).catch(() => undefined);
        if (chat?.synced !== undefined) await local.remove(link.key, summary.id).catch(() => {});
      }
    }
  }
}
