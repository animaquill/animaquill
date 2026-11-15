import {
  ChatImagesMissing,
  ChatNewer,
  ChatOutdated,
  type AccountAccess,
  type ChatImageHeld,
  type ChatImageStore,
  type ChatImageUsage,
  type ChatStore,
  type ChatSyncAccess,
  type CloudLinks,
  type SavedChat,
  type SavedChatSummary,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

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
  /**
   * Whether the conversations go with the account now, see `CloudSync.allows`: while not, they
   * are of this browser only. Always where it is not given.
   */
  readonly allowed?: (account: string) => boolean;
  /**
   * The pictures of conversations in this browser: those a conversation has go to the account
   * before it, see `ChatSyncAccess.putImage`. Without it, conversations go without their pictures.
   */
  readonly images?: ChatImageStore;
  readonly now?: () => number;
}

/** Pictures one conversation has on the account at most; those beyond stay here (`many`). */
export const IMAGES_PER_CHAT = 100;
/** How long a picture that stayed here waits before it is tried again, as the conversation goes. */
export const HELD_RETRY_MS = 10 * 60_000;

/** A picture as a conversation names it, in an entry of what people said. */
type NamedImage = {
  readonly image: string;
  readonly type?: string;
  readonly held?: ChatImageHeld;
};

/** The pictures a conversation names, in order, each once. */
const imagesOfChat = (chat: SavedChat): NamedImage[] => {
  const found = new Map<string, NamedImage>();
  for (const entry of chat.entries) {
    const images = (entry as { images?: unknown }).images;
    if (!Array.isArray(images)) continue;
    for (const image of images as NamedImage[]) {
      if (typeof image?.image === "string" && !found.has(image.image))
        found.set(image.image, image);
    }
  }
  return [...found.values()];
};

/** A conversation whose pictures say which stayed here: `held` by picture, the rest went. */
const withHeld = (chat: SavedChat, held: ReadonlyMap<string, ChatImageHeld>): SavedChat => ({
  ...chat,
  entries: chat.entries.map((entry) => {
    const images = (entry as { images?: unknown }).images;
    if (!Array.isArray(images)) return entry;
    return {
      ...(entry as object),
      images: (images as NamedImage[]).map((image) => {
        const { held: _held, ...rest } = image;
        const why = held.get(image.image);
        return why === undefined ? rest : { ...rest, held: why };
      }),
    };
  }),
});

/** How the conversations stand with the account, for people to see. */
export interface CloudChatsSnapshot {
  /** "outdated": the platform takes no conversation from this page until it is reloaded. */
  readonly status: "idle" | "synced" | "offline" | "failed" | "outdated";
  /** When the account last took or gave one. */
  readonly syncedAt: number | undefined;
}

/** Whether a conversation has what the account does not: changed here since it last went, or never went. */
export const isUnsent = (chat: SavedChat): boolean =>
  chat.synced === undefined || chat.syncedAt === undefined || chat.updatedAt > chat.syncedAt;

/** Whether two versions of a conversation say the same: what was said, and what it is called. */
const sameContent = (a: SavedChat, b: SavedChat): boolean =>
  a.title === b.title && JSON.stringify(a.entries) === JSON.stringify(b.entries);

const copyId = () =>
  `chat-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36)}`;

/**
 * Rules, each with a test in cloud-chats.test.ts:
 *
 * - Where the account's version of a conversation takes the place of one changed here (another
 *   device wrote it since), this browser's is kept first as a new conversation, "《X》在这台设备上的副本", which goes to the account in turn, and people are told; not where both say the
 *   same.
 * - Signing out lets go only of conversations that are as the account has them; the others stay,
 *   for their link says whose project they are of, and go once that account is signed in again.
 * - Turned off on this device (`allowed`), conversations are of this browser only: nothing goes,
 *   and the account's stay as they are. Turned on again, what changed here goes as above.
 */
export class CloudChats implements ChatStore {
  readonly #options: CloudChatsOptions;
  /** Writes of each conversation, one after the other. */
  readonly #writing = new Map<string, Promise<unknown>>();
  readonly #emitter = new Emitter();
  #snapshot: CloudChatsSnapshot = { status: "idle", syncedAt: undefined };
  /** Pictures this window knows the account has, and whose account that is. */
  #stored = { account: "", images: new Set<string>() };
  /** Pictures that stayed in this browser as their conversation went, why, and when last tried. */
  readonly #held = new Map<string, { readonly why: ChatImageHeld; readonly at: number }>();
  /**
   * What the account has of each conversation here, as it was last seen: a save does not wait for
   * a read of it, so that a page that goes right after an answer takes the answer along.
   */
  readonly #sync = new Map<string, { synced?: number; syncedAt?: number }>();

  /** Pictures of the account on their way here, by their hash. */
  readonly #fetching = new Map<string, Promise<Blob | undefined>>();

  constructor(options: CloudChatsOptions) {
    this.#options = options;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): CloudChatsSnapshot => this.#snapshot;

  /** The account answered: everything is as it has it, as far as this window asked. */
  #went(): void {
    this.#snapshot = { status: "synced", syncedAt: Date.now() };
    this.#emitter.emit();
  }

  /** The account could not be asked: what changed here goes the next time. */
  #failed(): void {
    this.#snapshot = {
      ...this.#snapshot,
      status: globalThis.navigator?.onLine === false ? "offline" : "failed",
    };
    this.#emitter.emit();
  }

  /** The project of the platform a project of this browser is, while somebody is signed in. */
  async #cloudOf(key: string): Promise<string | undefined> {
    const snapshot = this.#options.account.getSnapshot();
    if (snapshot.status !== "signedIn") return undefined;
    if (snapshot.id !== undefined && !(this.#options.allowed?.(snapshot.id) ?? true))
      return undefined;
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
      const listed = await remote.list(cloud);
      there = listed.chats;
      this.#went();
    } catch (error) {
      console.warn("The conversations of the account could not be read", error);
      this.#failed();
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
    if (here) this.#seen(here);
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
      this.#failed();
      return here;
    }
  }

  async save(chat: SavedChat): Promise<void> {
    const { local } = this.#options;
    const key = `${chat.project}\n${chat.id}`;
    const before =
      this.#sync.get(key) ?? (await local.load(chat.project, chat.id).catch(() => undefined));
    const saved: SavedChat = {
      ...chat,
      ...(before?.synced !== undefined && { synced: before.synced }),
      ...(before?.syncedAt !== undefined && { syncedAt: before.syncedAt }),
    };
    this.#seen(saved);
    await local.save(saved);
    const cloud = await this.#cloudOf(chat.project);
    if (cloud === undefined) return;
    await this.#give(cloud, saved);
  }

  #seen(chat: SavedChat): void {
    this.#sync.set(`${chat.project}\n${chat.id}`, {
      ...(chat.synced !== undefined && { synced: chat.synced }),
      ...(chat.syncedAt !== undefined && { syncedAt: chat.syncedAt }),
    });
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
          let revision;
          try {
            revision = await remote.save(cloud, await this.#withImages(chat), base);
          } catch (error) {
            if (!(error instanceof ChatImagesMissing)) throw error;
            // The account lost some since, as after a round that took them away: once more.
            revision = await remote.save(
              cloud,
              await this.#withImages(chat, new Set(error.images.map((hash) => `sha256:${hash}`))),
              base,
            );
          }
          this.#went();
          if (revision === undefined) return;
          const latest = await local.load(chat.project, chat.id).catch(() => undefined);
          const synced = { ...(latest ?? chat), synced: revision, syncedAt: chat.updatedAt };
          this.#seen(synced);
          await local.save(synced);
        } catch (error) {
          if (error instanceof ChatOutdated) {
            // It stays here, and goes once the page is reloaded with a newer editor.
            this.#snapshot = { ...this.#snapshot, status: "outdated" };
            this.#emitter.emit();
            return;
          }
          if (!(error instanceof ChatNewer)) {
            // It stays here, and goes the next time.
            console.warn("A conversation could not go to the account", error);
            this.#failed();
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
   * Why a picture stayed in this browser as its conversation went to the account, as this window
   * last tried; nothing where it went, or this window did not try.
   */
  heldOf(image: string): ChatImageHeld | undefined {
    return this.#held.get(image)?.why;
  }

  /** Pictures known to be on the account, of the account signed in now. */
  #storedNow(): Set<string> | undefined {
    const snapshot = this.#options.account.getSnapshot();
    if (snapshot.status !== "signedIn" || snapshot.id === undefined) return undefined;
    if (this.#stored.account !== snapshot.id)
      this.#stored = { account: snapshot.id, images: new Set() };
    return this.#stored.images;
  }

  /**
   * A conversation as it goes to the account: each of its pictures there first, unless it is known
   * to be; those that cannot go (no room, too many, the platform keeps none now) say so (`held`) and
   * stay here, to be tried again as it goes later. `again`: pictures the account turned out not to
   * have after all.
   */
  async #withImages(chat: SavedChat, again: ReadonlySet<string> = new Set()): Promise<SavedChat> {
    const { remote, images } = this.#options;
    const named = imagesOfChat(chat);
    if (named.length === 0 || !remote.putImage) return chat;
    const stored = this.#storedNow() ?? new Set<string>();
    for (const image of again) stored.delete(image);
    const now = (this.#options.now ?? Date.now)();
    const held = new Map<string, ChatImageHeld>();
    let changed = false;
    let there = 0;
    for (const { image, type, held: said } of named) {
      if (stored.has(image)) {
        there += 1;
        continue;
      }
      const blob = await images?.read(image).catch(() => undefined);
      if (!blob) {
        // Of another device: as that one said, unless the account turned out not to have it.
        if (said !== undefined) held.set(image, said);
        else if (again.has(image)) held.set(image, "unavailable");
        continue;
      }
      let why: ChatImageHeld | undefined;
      let at = now;
      const tried = this.#held.get(image);
      if (there >= IMAGES_PER_CHAT) why = "many";
      else if (
        tried &&
        tried.why !== "many" &&
        now - tried.at < HELD_RETRY_MS &&
        !again.has(image)
      ) {
        why = tried.why;
        at = tried.at;
      } else {
        const ref = {
          image,
          type: blob.type || (type ?? ""),
          width: 0,
          height: 0,
          bytes: blob.size,
        };
        const outcome = await remote.putImage(ref, blob).catch((error: unknown) => {
          console.warn("A picture of a conversation could not go to the account", error);
          return "unavailable" as const;
        });
        if (outcome === "stored") {
          stored.add(image);
          there += 1;
        } else why = outcome;
      }
      if (why === undefined) {
        changed = this.#held.delete(image) || changed;
        continue;
      }
      held.set(image, why);
      if (tried?.why !== why) changed = true;
      this.#held.set(image, { why, at });
    }
    if (changed) this.#emitter.emit();
    return withHeld(chat, held);
  }

  /**
   * The pictures of conversations as the chat reads them: those of this browser, and those of
   * the account, which come here as they are first read (to show, or to go to a model).
   */
  pictures(local: ChatImageStore): ChatImageStore {
    return {
      save: (blob, size) => local.save(blob, size),
      keys: () => local.keys(),
      delete: (images) => local.delete(images),
      read: async (image) => {
        const here = await local.read(image).catch(() => undefined);
        return here ?? this.#fetchImage(image, local);
      },
    };
  }

  #fetchImage(image: string, local: ChatImageStore): Promise<Blob | undefined> {
    const { remote, account, allowed } = this.#options;
    const snapshot = account.getSnapshot();
    if (!remote.getImage || snapshot.status !== "signedIn") return Promise.resolve(undefined);
    if (snapshot.id !== undefined && !(allowed?.(snapshot.id) ?? true))
      return Promise.resolve(undefined);
    const known = this.#fetching.get(image);
    if (known) return known;
    const getImage = remote.getImage.bind(remote);
    const fetching = (async () => {
      try {
        const blob = await getImage({ image, type: "", width: 0, height: 0, bytes: 0 });
        if (!blob) return undefined;
        const kept = await local.save(blob, { width: 0, height: 0 });
        if (kept.image !== image) return undefined;
        this.#storedNow()?.add(image);
        return blob;
      } catch (error) {
        console.warn("A picture of the account could not be read", error);
        return undefined;
      } finally {
        this.#fetching.delete(image);
      }
    })();
    this.#fetching.set(image, fetching);
    return fetching;
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
    // The same as the account has it: nothing to keep.
    if (here && isUnsent(here) && !sameContent(here, there.chat)) {
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
    this.#seen(chat);
    await local.save(chat);
    return chat;
  }

  async remove(project: string, id: string): Promise<void> {
    await this.#options.local.remove(project, id);
    const cloud = await this.#cloudOf(project);
    if (cloud !== undefined) await this.#options.remote.remove(cloud, id);
  }

  /**
   * How much of their room the pictures of the account's conversations take, by conversation;
   * nothing where the platform keeps no pictures. Rejects where it could not be asked.
   */
  async imageUsage(): Promise<ChatImageUsage | undefined> {
    const { remote } = this.#options;
    if (!remote.imageUsage) return undefined;
    return remote.imageUsage();
  }

  /**
   * Takes a conversation of the account away, by its project on the platform, as people do from
   * the room its pictures take: there, and from this browser.
   */
  async removeOnAccount(cloudProject: string, id: string): Promise<void> {
    const { local, links, platform, remote } = this.#options;
    await remote.remove(cloudProject, id);
    for (const link of await links.list().catch(() => [])) {
      if (link.platform !== platform || link.project !== cloudProject) continue;
      await local.remove(link.key, id).catch(() => {});
    }
  }

  async forget(project: string): Promise<void> {
    await this.#options.local.forget(project);
  }

  /**
   * Gives the account every conversation of its projects that changed here since it last went, or
   * never went, as after the platform could not be reached; "synced" once none is left. Never
   * rejects.
   */
  async retry(): Promise<void> {
    const snapshot = this.#options.account.getSnapshot();
    if (snapshot.status !== "signedIn") return;
    if (snapshot.id !== undefined && !(this.#options.allowed?.(snapshot.id) ?? true)) return;
    const { local, links, platform } = this.#options;
    const all = await links.list().catch(() => []);
    let failed = false;
    for (const link of all) {
      if (link.platform !== platform) continue;
      const cloud = await this.#cloudOf(link.key);
      if (cloud === undefined) continue;
      for (const summary of await local.list(link.key).catch(() => [])) {
        const chat = await local.load(link.key, summary.id).catch(() => undefined);
        if (!chat || !isUnsent(chat)) continue;
        await this.#give(cloud, chat).catch(() => {});
        const after = await local.load(link.key, summary.id).catch(() => undefined);
        if (after && isUnsent(after)) failed = true;
      }
    }
    // Everything of this browser is on the account, as far as it can tell.
    if (!failed) this.#went();
  }

  /**
   * Lets go of what this browser keeps of the account's conversations, as people sign out: those
   * as the account has them are gone from here; one changed here that the account does not have yet
   * stays, as it is nowhere else, and goes once the account is signed in here again.
   */
  async beforeSignOut(): Promise<void> {
    await Promise.allSettled(this.#writing.values());
    this.#stored = { account: "", images: new Set() };
    this.#held.clear();
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
