import {
  ChatImagesMissing,
  ChatNewer,
  ChatOutdated,
  type ChatImageHeld,
  type ChatImageStore,
  type ChatImageUsage,
  type ChatStore,
  type ChatSyncAccess,
  type SavedChat,
  type SavedChatSummary,
} from "@animaquill/host";
import { Emitter } from "../workbench/emitter.ts";

/**
 * The conversations of the online mode (docs/design/online-offline.md of AnimaQuill Cloud, 2.1):
 * the backend has them, see `ChatSyncAccess`. What the list shows and what a conversation opens
 * with is read from it each time. A conversation is written whole, over the revision this page
 * read it at; where another device wrote it since, theirs is the conversation, and what this page
 * had goes to the backend as a copy of its own, "《X》在这台设备上的副本", which people are told.
 *
 * Nothing of a conversation stays in this browser once the backend has it. Until then, as while
 * the backend cannot be reached, it waits in the browser (`outbox`, the conversations of the
 * online scope), and goes as soon as it can: as this page starts, comes to the front, or the
 * browser goes online. One that waits shows in the list and opens as it is, so that a page that
 * went away meanwhile loses nothing.
 */

export interface AccountChatsOptions {
  readonly remote: ChatSyncAccess;
  /** What waits for the backend, see above. */
  readonly outbox: ChatStore;
  /** The project on the backend a project of this window is, by what it is kept by here. */
  readonly projectOf: (key: string) => Promise<string | undefined>;
  /**
   * The backend had another version of a conversation than this page, which had changed it too:
   * this page's went into a new conversation, `copy`, and the backend's took its place.
   */
  readonly copied?: (title: string, copy: string) => void;
  /**
   * The pictures of conversations in this browser: those a conversation has go to the backend
   * before it, see `ChatSyncAccess.putImage`. Without it, conversations go without their pictures.
   */
  readonly images?: ChatImageStore;
  readonly now?: () => number;
}

/** Pictures one conversation has on the backend at most; those beyond stay here (`many`). */
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

/** How the conversations stand with the backend, for people to see. */
export interface AccountChatsSnapshot {
  /**
   * "waiting": some wait in this browser for the backend; "outdated": the backend takes no
   * conversation from this page until it is reloaded.
   */
  readonly status: "idle" | "synced" | "waiting" | "outdated";
}

/** Whether two versions of a conversation say the same: what was said, and what it is called. */
const sameContent = (a: SavedChat, b: SavedChat): boolean =>
  a.title === b.title && JSON.stringify(a.entries) === JSON.stringify(b.entries);

const copyId = () =>
  `chat-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36)}`;

export class AccountChats implements ChatStore {
  readonly #options: AccountChatsOptions;
  /** Writes of each conversation, one after the other. */
  readonly #writing = new Map<string, Promise<unknown>>();
  readonly #emitter = new Emitter();
  #snapshot: AccountChatsSnapshot = { status: "idle" };
  /** The revision the backend has of each conversation, as this page last read or wrote it. */
  readonly #revisions = new Map<string, number>();
  /** What the backend listed of each project, as this page last read it. */
  readonly #listed = new Map<string, readonly SavedChatSummary[]>();
  /** Pictures this page knows the backend has. */
  readonly #stored = new Set<string>();
  /** Pictures that stayed in this browser as their conversation went, why, and when last tried. */
  readonly #held = new Map<string, { readonly why: ChatImageHeld; readonly at: number }>();
  /** Pictures of the backend on their way here, by their hash. */
  readonly #fetching = new Map<string, Promise<Blob | undefined>>();
  #flushing: Promise<void> | undefined;

  constructor(options: AccountChatsOptions) {
    this.#options = options;
  }

  subscribe = this.#emitter.subscribe;
  getSnapshot = (): AccountChatsSnapshot => this.#snapshot;

  #set(status: AccountChatsSnapshot["status"]): void {
    if (this.#snapshot.status === status) return;
    this.#snapshot = { status };
    this.#emitter.emit();
  }

  async list(project: string): Promise<readonly SavedChatSummary[]> {
    const { remote, outbox, projectOf } = this.#options;
    const waiting = await outbox.list(project).catch(() => [] as const);
    const cloud = await projectOf(project);
    if (cloud === undefined) return waiting;
    let there: readonly SavedChatSummary[];
    try {
      const listed = await remote.list(cloud);
      for (const each of listed.chats)
        this.#revisions.set(`${project}\n${each.summary.id}`, each.revision);
      there = listed.chats.map(({ summary }) => ({ ...summary, project }) as SavedChatSummary);
      this.#listed.set(project, there);
    } catch (error) {
      // As this page last read it, while the backend cannot be reached.
      const last = this.#listed.get(project);
      if (!last && waiting.length === 0) throw error;
      there = last ?? [];
    }
    const here = new Set(waiting.map(({ id }) => id));
    const all = [...waiting, ...there.filter(({ id }) => !here.has(id))];
    if (waiting.length > 0) void this.flush();
    return all.toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(project: string, id: string): Promise<SavedChat | undefined> {
    const { remote, outbox, projectOf } = this.#options;
    // One that waits here is newer than what the backend has.
    const waiting = await outbox.load(project, id).catch(() => undefined);
    if (waiting) {
      void this.flush();
      return waiting;
    }
    const cloud = await projectOf(project);
    if (cloud === undefined) return undefined;
    const there = await remote.load(cloud, id);
    if (!there) return undefined;
    this.#revisions.set(`${project}\n${id}`, there.revision);
    return { ...there.chat, project };
  }

  async save(chat: SavedChat): Promise<void> {
    const key = `${chat.project}\n${chat.id}`;
    const base = this.#revisions.get(key);
    const waiting: SavedChat = {
      ...chat,
      ...(base !== undefined && { synced: base }),
    };
    // Kept here first: if the backend cannot have it now, nothing is lost.
    await this.#options.outbox.save(waiting);
    this.#set("waiting");
    await this.#give(waiting);
  }

  /**
   * Writes a conversation that waits here to the backend, after the writes of it before, and lets
   * go of it here once the backend has it. Rejects with a `ChatNewer` where another device wrote it
   * since: theirs is the conversation then, and this one's went into a copy.
   */
  #give(chat: SavedChat): Promise<void> {
    const key = `${chat.project}\n${chat.id}`;
    const next = (this.#writing.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const { remote, outbox, projectOf } = this.#options;
        const cloud = await projectOf(chat.project);
        if (cloud === undefined) return;
        // The revision as it is now: an earlier write may have moved it on.
        const base = this.#revisions.get(key) ?? chat.synced ?? null;
        const { synced: _synced, syncedAt: _syncedAt, ...sent } = chat;
        try {
          let revision;
          try {
            revision = await remote.save(cloud, await this.#withImages(sent), base);
          } catch (error) {
            if (!(error instanceof ChatImagesMissing)) throw error;
            // The backend lost some since: once more, with those.
            revision = await remote.save(
              cloud,
              await this.#withImages(sent, new Set(error.images.map((hash) => `sha256:${hash}`))),
              base,
            );
          }
          // Not one the backend keeps (too large, a project gone): it stays here, as it is.
          if (revision === undefined) return;
          this.#revisions.set(key, revision);
          const now = await outbox.load(chat.project, chat.id).catch(() => undefined);
          // Changed again meanwhile: that goes next.
          if (now && now.updatedAt === chat.updatedAt && sameContent(now, chat))
            await outbox.remove(chat.project, chat.id);
          else if (now) await outbox.save({ ...now, synced: revision });
        } catch (error) {
          if (error instanceof ChatOutdated) {
            this.#set("outdated");
            return;
          }
          if (!(error instanceof ChatNewer)) {
            // It waits here, and goes the next time.
            console.warn("A conversation could not go to the backend yet", error);
            return;
          }
          await this.#replaced(chat, cloud);
          throw error;
        } finally {
          await this.#settle();
        }
      });
    this.#writing.set(key, next);
    return next;
  }

  /**
   * Another device wrote a conversation since this page read it: the backend's is the
   * conversation, and what this page had, where it says something else, a new one.
   */
  async #replaced(chat: SavedChat, cloud: string): Promise<void> {
    const { remote, outbox } = this.#options;
    const key = `${chat.project}\n${chat.id}`;
    const theirs = await remote.load(cloud, chat.id).catch(() => undefined);
    if (theirs) this.#revisions.set(key, theirs.revision);
    else this.#revisions.delete(key);
    const mine = (await outbox.load(chat.project, chat.id).catch(() => undefined)) ?? chat;
    if (!theirs || !sameContent(mine, theirs.chat)) {
      const title = `《${mine.title}》在这台设备上的副本`;
      const {
        synced: _synced,
        syncedAt: _syncedAt,
        titleBy: _titleBy,
        forkedFrom: _forkedFrom,
        ...rest
      } = mine;
      const copy: SavedChat = { ...rest, id: copyId(), title, titleBy: "user" };
      // Kept before this page lets go of its version: if this fails, nothing is let go of.
      await outbox.save(copy);
      this.#options.copied?.(mine.title, title);
      void this.#give(copy).catch(() => {});
    }
    await outbox.remove(chat.project, chat.id);
  }

  /** How it stands: waiting while anything is left here. */
  async #settle(): Promise<void> {
    if (this.#snapshot.status === "outdated") return;
    const usage = await this.#options.outbox.usage?.().catch(() => undefined);
    this.#set(usage === undefined || usage.length === 0 ? "synced" : "waiting");
  }

  /** Gives the backend every conversation that waits here. Never rejects. */
  flush(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #flush(): Promise<void> {
    const { outbox } = this.#options;
    const usage = await outbox.usage?.().catch(() => undefined);
    for (const { project } of usage ?? []) {
      for (const summary of await outbox.list(project).catch(() => [])) {
        const chat = await outbox.load(project, summary.id).catch(() => undefined);
        if (chat) await this.#give(chat).catch(() => {});
      }
    }
    await this.#settle();
  }

  /**
   * Why a picture stayed in this browser as its conversation went to the backend, as this page
   * last tried; nothing where it went, or this page did not try.
   */
  heldOf(image: string): ChatImageHeld | undefined {
    return this.#held.get(image)?.why;
  }

  /**
   * A conversation as it goes to the backend: each of its pictures there first, unless it is known
   * to be; those that cannot go (no room, too many, the backend keeps none now) say so (`held`) and
   * stay here, to be tried again as it goes later. `again`: pictures the backend turned out not to
   * have after all.
   */
  async #withImages(chat: SavedChat, again: ReadonlySet<string> = new Set()): Promise<SavedChat> {
    const { remote, images } = this.#options;
    const named = imagesOfChat(chat);
    if (named.length === 0 || !remote.putImage) return chat;
    for (const image of again) this.#stored.delete(image);
    const now = (this.#options.now ?? Date.now)();
    const held = new Map<string, ChatImageHeld>();
    let changed = false;
    let there = 0;
    for (const { image, type, held: said } of named) {
      if (this.#stored.has(image)) {
        there += 1;
        continue;
      }
      const blob = await images?.read(image).catch(() => undefined);
      if (!blob) {
        // Of another device: as that one said, unless the backend turned out not to have it.
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
          console.warn("A picture of a conversation could not go to the backend", error);
          return "unavailable" as const;
        });
        if (outcome === "stored") {
          this.#stored.add(image);
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
   * The pictures of conversations as the chat reads them: those of this browser, and those of the
   * backend, which come here as they are first read (to show, or to go to a model).
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
    const { remote } = this.#options;
    if (!remote.getImage) return Promise.resolve(undefined);
    const known = this.#fetching.get(image);
    if (known) return known;
    const getImage = remote.getImage.bind(remote);
    const fetching = (async () => {
      try {
        const blob = await getImage({ image, type: "", width: 0, height: 0, bytes: 0 });
        if (!blob) return undefined;
        const kept = await local.save(blob, { width: 0, height: 0 });
        if (kept.image !== image) return undefined;
        this.#stored.add(image);
        return blob;
      } catch (error) {
        console.warn("A picture of the backend could not be read", error);
        return undefined;
      } finally {
        this.#fetching.delete(image);
      }
    })();
    this.#fetching.set(image, fetching);
    return fetching;
  }

  /** Takes a conversation away: on the backend, and whatever of it waits here. */
  async remove(project: string, id: string): Promise<void> {
    const { remote, outbox, projectOf } = this.#options;
    await this.#writing.get(`${project}\n${id}`)?.catch(() => {});
    const cloud = await projectOf(project);
    if (cloud !== undefined) await remote.remove(cloud, id);
    await outbox.remove(project, id).catch(() => {});
    this.#revisions.delete(`${project}\n${id}`);
    await this.#settle();
  }

  /**
   * How much of their room the pictures of the person's conversations take, by conversation;
   * nothing where the backend keeps no pictures. Rejects where it could not be asked.
   */
  async imageUsage(): Promise<ChatImageUsage | undefined> {
    const { remote } = this.#options;
    if (!remote.imageUsage) return undefined;
    return remote.imageUsage();
  }

  /**
   * Takes a conversation away by its project on the backend, as people do from the room its
   * pictures take: there, and whatever of it waits here.
   */
  async removeOnAccount(cloudProject: string, id: string): Promise<void> {
    const { remote, outbox, projectOf } = this.#options;
    await remote.remove(cloudProject, id);
    for (const { project } of (await outbox.usage?.().catch(() => undefined)) ?? []) {
      if ((await projectOf(project)) === cloudProject)
        await outbox.remove(project, id).catch(() => {});
    }
  }

  /** What waits here of a project that is gone. */
  async forget(project: string): Promise<void> {
    await this.#options.outbox.forget(project);
  }

  /** How many conversations wait here for the backend. */
  async waiting(): Promise<number> {
    const usage = await this.#options.outbox.usage?.().catch(() => undefined);
    return (usage ?? []).reduce((sum, { count }) => sum + count, 0);
  }
}
