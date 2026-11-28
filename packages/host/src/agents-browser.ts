import { committed, connector, resultOf } from "./ai.ts";
import { scoped } from "./scope.ts";
import type {
  AgentPost,
  AgentRoom,
  AgentRoomEvents,
  AgentRosterEntry,
  PostedMail,
} from "./index.ts";

/**
 * The conversations and AI tools of a project in the windows of this browser, see `AgentPost`
 * (chat6 technical design of AnimaQuill Cloud, 6.2): Web Locks say which window has which, and
 * that one is gone with its window; IndexedDB keeps what they are, the messages that wait and who
 * waits to be told, in transactions that one window at a time gets; a BroadcastChannel only says
 * that something came. No window relays for the others, so none has to be chosen or taken over.
 */

const DATABASE = "animaquill-agents";
const VERSION = 2;
const CARDS = "cards";
const MAIL = "mail";
const WATCHES = "watches";
const BY_PROJECT = "project";
const BY_TO = "to";
const BY_TARGET = "target";
const BY_ID = "id";
/** One exclusive lock for each window for as long as it takes part: what it took goes with it. */
const WINDOW_LOCK = "animaquill.agents.window.";
/** Who waits to be told of one at most. */
export const MAX_WATCHERS = 50;
/** One exclusive lock for each one a window has, see `presence.ts` for the shared ones. */
const LOCK = "animaquill.agent.";
const CHANNEL = "animaquill-agents";
/** Where the windows count the turns nobody was there for, see `AgentRoom.budget`. */
const BUDGET = "animaquill.agents.unattended.";

/** How long the cards of one whose window went are still listed, and a count still counts. */
export const AWAY_MS = 12 * 60 * 60 * 1000;
/** How long a message waits for one that nobody opens, at most. */
export const MAIL_MS = 7 * 24 * 60 * 60 * 1000;
/** How long a card stays as it is before the window says it again, so that it does not look old. */
const FRESH_MS = 60 * 1000;
/** How long one taken with `tryServe` stays held before `serve` has to say it has it. */
const PINNED_MS = 5_000;

interface CardRecord {
  readonly project: string;
  readonly id: string;
  readonly window: string;
  readonly at: number;
  readonly card: unknown;
}

interface MailRecord extends PostedMail {
  readonly project: string;
  /** The window that took it, and has it until it is done with it or gives it back. */
  readonly claimedBy?: string;
}

interface WatchRecord {
  readonly project: string;
  readonly target: string;
  readonly watcher: string;
  readonly until: number;
}

type Signal =
  | { readonly project: string; readonly kind: "mail"; readonly to: string }
  | {
      readonly project: string;
      readonly kind: "answer";
      readonly mail: string;
      readonly outcome: unknown;
    }
  | { readonly project: string; readonly kind: "want"; readonly id: string; readonly take: boolean }
  | { readonly project: string; readonly kind: "gone"; readonly id: string };

/** One this window has, and how it stands with its lock. */
interface Held {
  readonly stop: AbortController;
  release: (() => void) | undefined;
  owned: boolean;
  /** Taken with `tryServe`, and when: `serve` lets go of it only after `PINNED_MS`. */
  pinned: number | undefined;
}

/** How many turns went on with nobody there, and when that was written. */
interface Count {
  readonly n: number;
  readonly at: number;
}

/** A count as the storage keeps it; undefined where there is none, or it cannot be read. */
function budgetOf(text: string | null | undefined): Count | undefined {
  if (!text) return undefined;
  try {
    const found = JSON.parse(text) as { n?: unknown; at?: unknown };
    return {
      n: typeof found.n === "number" && found.n > 0 ? found.n : 0,
      at: typeof found.at === "number" ? found.at : 0,
    };
  } catch {
    return undefined;
  }
}

const newWindowId = () =>
  `w-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36)}`;

export interface BrowserAgentsOptions {
  readonly database?: () => IDBFactory;
  readonly locks?: () => LockManager | undefined;
  readonly channel?: (name: string) => BroadcastChannel | undefined;
  readonly storage?: () => Storage | undefined;
  /** Where the storage of another window changes, see `StorageEvent`. */
  readonly listenStorage?: (listener: (event: StorageEvent) => void) => () => void;
  /** Where the page goes away, see `pagehide`. */
  readonly listenPageHide?: (listener: () => void) => () => void;
  /** Where the page comes back from the browser's cache, see `pageshow` and `persisted`. */
  readonly listenPageShow?: (listener: () => void) => () => void;
}

export function browserAgents({
  database: factory = () => indexedDB,
  locks = () => navigator.locks,
  channel = (name) =>
    typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(name),
  storage = () => (typeof localStorage === "undefined" ? undefined : localStorage),
  listenStorage = (listener) => {
    if (typeof addEventListener === "undefined") return () => {};
    addEventListener("storage", listener);
    return () => removeEventListener("storage", listener);
  },
  listenPageHide = (listener) => {
    if (typeof addEventListener === "undefined") return () => {};
    addEventListener("pagehide", listener);
    return () => removeEventListener("pagehide", listener);
  },
  listenPageShow = (listener) => {
    if (typeof addEventListener === "undefined") return () => {};
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) listener();
    };
    addEventListener("pageshow", shown);
    return () => removeEventListener("pageshow", shown);
  },
}: BrowserAgentsOptions = {}): AgentPost {
  const database = connector(() => {
    const request = factory().open(scoped(DATABASE), VERSION);
    request.addEventListener("upgradeneeded", (event) => {
      const made = request.result;
      if (event.oldVersion < 1) {
        const cards = made.createObjectStore(CARDS, { keyPath: [BY_PROJECT, "id"] });
        cards.createIndex(BY_PROJECT, BY_PROJECT);
        const mail = made.createObjectStore(MAIL, { keyPath: "seq", autoIncrement: true });
        mail.createIndex(BY_TO, [BY_PROJECT, "to"]);
        const watches = made.createObjectStore(WATCHES, {
          keyPath: [BY_PROJECT, "target", "watcher"],
        });
        watches.createIndex(BY_TARGET, [BY_PROJECT, "target"]);
      }
      // Messages by their id, for the window that took them to say it is done with them.
      if (event.oldVersion < 2) {
        request.transaction?.objectStore(MAIL).createIndex(BY_ID, [BY_PROJECT, "id"]);
      }
    });
    return resultOf(request);
  });
  const lockName = (project: string, id: string) => scoped(`${LOCK}${project}.${id}`);
  const budgetKey = (project: string) => scoped(`${BUDGET}${project}`);
  const windowLock = (window: string) => scoped(`${WINDOW_LOCK}${window}`);
  /** The locks the windows of the browser hold now; none where nobody can tell. */
  const heldNow = async (): Promise<Set<string> | undefined> => {
    const manager = locks();
    if (!manager) return undefined;
    return new Set(
      ((await manager.query()).held ?? []).flatMap(({ name }) => (name ? [name] : [])),
    );
  };

  return {
    enter(project, events: AgentRoomEvents): AgentRoom {
      const window = newWindowId();
      const held = new Map<string, Held>();
      let isOver = false;
      /** What this window said last, so that the same is not written again. */
      let said = new Map<string, { readonly text: string; readonly at: number }>();
      const waiting = new Map<string, (outcome: unknown) => void>();
      const wire = channel(scoped(CHANNEL));
      const onSignal = (event: MessageEvent<Signal>) => {
        const signal = event.data;
        if (isOver || typeof signal !== "object" || signal === null) return;
        if (signal.project !== project) return;
        if (signal.kind === "mail" && typeof signal.to === "string") {
          if (held.get(signal.to)?.owned) events.mail(signal.to);
        } else if (signal.kind === "answer" && typeof signal.mail === "string") {
          waiting.get(signal.mail)?.(signal.outcome);
        } else if (signal.kind === "want" && typeof signal.id === "string") {
          if (held.get(signal.id)?.owned) events.wanted?.(signal.id, signal.take === true);
        } else if (signal.kind === "gone" && typeof signal.id === "string") {
          if (held.has(signal.id)) events.gone?.(signal.id);
        }
      };
      wire?.addEventListener("message", onSignal as EventListener);
      const tell = (signal: Signal) => {
        try {
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- not a window
          wire?.postMessage(signal);
        } catch (error) {
          console.warn("The other windows could not be told", error);
        }
      };
      const unlisten = listenStorage((event) => {
        if (isOver || event.key !== budgetKey(project)) return;
        // What all windows say goes: also people saying something there, which this window
        // counted otherwise.
        const written = budgetOf(event.newValue);
        if (written) {
          stored = written;
          own = written;
        }
        events.budget();
      });
      /** The messages this window took and has, until it is done with them or gives them back. */
      const taken = new Set<string>();
      // The lock of this window, which says to the others that what it took is still taken.
      let leave = () => {};
      locks()
        ?.request(windowLock(window), { mode: "exclusive" }, () => {
          if (isOver) return undefined;
          return new Promise<void>((resolve) => {
            leave = resolve;
          });
        })
        .catch(() => {});
      /** Of those taken, the ones a conversation read: they go as the page goes, see `read`. */
      const readHere = new Set<string>();
      const dropAll = async (ids: readonly string[]) => {
        if (ids.length === 0) return;
        const transaction = (await database()).transaction(MAIL, "readwrite");
        const store = transaction.objectStore(MAIL);
        const index = store.index(BY_ID);
        for (const id of ids) {
          taken.delete(id);
          readHere.delete(id);
          const key = await resultOf(index.getKey([project, id]));
          if (key !== undefined) store.delete(key);
        }
        await committed(transaction);
      };
      const giveBack = async (ids: readonly string[]) => {
        if (ids.length === 0) return;
        const transaction = (await database()).transaction(MAIL, "readwrite");
        const store = transaction.objectStore(MAIL);
        const index = store.index(BY_ID);
        for (const id of ids) {
          taken.delete(id);
          const key = await resultOf(index.getKey([project, id]));
          if (key === undefined) continue;
          const found = (await resultOf(store.get(key))) as MailRecord | undefined;
          if (!found || found.claimedBy !== window) continue;
          const { claimedBy: _claimedBy, ...rest } = found;
          store.put({ ...rest, left: true });
        }
        await committed(transaction);
      };
      // A page that goes gives back what it took, where it gets to; where it does not, its lock
      // goes with it and the others take them all the same.
      /** As the page or the room goes: what a conversation read goes, the rest goes back. */
      const leaving = async () => {
        const read = [...taken].filter((id) => readHere.has(id));
        const rest = [...taken].filter((id) => !readHere.has(id));
        await Promise.all([dropAll(read), giveBack(rest)]);
      };
      const unhide = listenPageHide(() => {
        void leaving().catch(() => {});
      });
      const unshow = listenPageShow(() => {
        if (!isOver) events.resumed?.();
      });

      /** Asks for the lock of one; `now` only where no window has it, and says whether it got it. */
      const hold = (id: string, now: boolean): Promise<boolean> => {
        const manager = locks();
        const stop = new AbortController();
        // One taken right away stays held a while, before `serve` says it has it.
        const entry: Held = {
          stop,
          release: undefined,
          owned: false,
          pinned: now ? Date.now() : undefined,
        };
        held.set(id, entry);
        if (!manager) {
          // Nobody can tell: this window is alone, and has all it has.
          entry.owned = true;
          queueMicrotask(() => !isOver && held.get(id) === entry && events.owned(id, false));
          return Promise.resolve(true);
        }
        const name = lockName(project, id);
        /** Holds it until it is let go of, once the browser gives it. */
        const keep = (waited: boolean) => (lock: Lock | null) => {
          if (!lock || isOver || held.get(id) !== entry || stop.signal.aborted) return false;
          entry.owned = true;
          events.owned(id, waited);
          return new Promise<void>((release) => {
            entry.release = release;
          });
        };
        const gone = () => {
          if (held.get(id) === entry) held.delete(id);
        };
        return new Promise<boolean>((resolve) => {
          // Right away where no window has it; else, unless only that is asked, in turn after
          // those that wait for it already.
          manager
            .request(name, { mode: "exclusive", ifAvailable: true }, (lock) => {
              const kept = keep(false)(lock);
              resolve(kept !== false);
              if (kept !== false) return kept;
              if (now || isOver || held.get(id) !== entry || stop.signal.aborted) {
                if (now) gone();
                return undefined;
              }
              events.queued?.(id);
              manager
                .request(name, { mode: "exclusive", signal: stop.signal }, (later) => {
                  const keeping = keep(true)(later);
                  return keeping === false ? undefined : keeping;
                })
                .catch(gone);
              return undefined;
            })
            .catch(() => {
              gone();
              resolve(false);
            });
        });
      };

      const letGo = (id: string) => {
        const entry = held.get(id);
        if (!entry) return;
        held.delete(id);
        entry.stop.abort();
        entry.release?.();
        said.delete(id);
        // What this window said of it goes, so that it is not taken for one whose window went away.
        if (entry.owned && !isOver) {
          void (async () => {
            const transaction = (await database()).transaction(CARDS, "readwrite");
            const store = transaction.objectStore(CARDS);
            const found = (await resultOf(store.get([project, id]))) as CardRecord | undefined;
            if (found?.window === window) store.delete([project, id]);
            await committed(transaction);
          })().catch(() => {});
        }
      };

      // What the windows wrote last, as this one read it; and what this window counted itself,
      // which counts all the same where the storage cannot be read or written: the count never
      // goes down for that, only for people.
      let stored: Count = { n: 0, at: 0 };
      try {
        stored = budgetOf(storage()?.getItem(budgetKey(project))) ?? stored;
      } catch {
        // Unreadable: this window counts on its own.
      }
      let own: Count = stored;
      const counting = (count: Count) => (Date.now() - count.at > AWAY_MS ? 0 : count.n);
      const readBudget = () => Math.max(counting(stored), counting(own));
      const writeBudget = (n: number) => {
        own = { n: Math.max(0, n), at: Date.now() };
        try {
          const place = storage();
          if (!place) return;
          place.setItem(budgetKey(project), JSON.stringify(own));
          stored = own;
        } catch {
          // Where the storage takes nothing, this window counts on its own.
        }
      };

      return {
        serve(ids) {
          if (isOver) return;
          const wanted = new Set(ids);
          const now = Date.now();
          for (const [id, entry] of Array.from(held)) {
            if (wanted.has(id)) {
              entry.pinned = undefined;
              continue;
            }
            if (entry.pinned !== undefined && now - entry.pinned < PINNED_MS) continue;
            letGo(id);
          }
          for (const id of wanted) if (!held.has(id)) void hold(id, false);
        },
        async tryServe(id) {
          if (isOver) return false;
          const had = held.get(id);
          if (had) return had.owned;
          return hold(id, true);
        },
        owns: (id) => held.get(id)?.owned === true,
        async held(id) {
          if (held.get(id)?.owned) return true;
          const manager = locks();
          if (!manager) return false;
          const { held: all = [] } = await manager.query();
          return all.some(({ name }) => name === lockName(project, id));
        },
        async publish(cards) {
          if (isOver) return;
          const now = Date.now();
          const next = new Map<string, { readonly text: string; readonly at: number }>();
          const writes: CardRecord[] = [];
          for (const { id, card } of cards) {
            if (!held.get(id)?.owned) continue;
            const text = JSON.stringify(card);
            const before = said.get(id);
            if (before && before.text === text && now - before.at < FRESH_MS) {
              next.set(id, before);
              continue;
            }
            next.set(id, { text, at: now });
            writes.push({ project, id, window, at: now, card });
          }
          said = next;
          if (writes.length === 0) return;
          const transaction = (await database()).transaction(CARDS, "readwrite");
          const store = transaction.objectStore(CARDS);
          for (const record of writes) store.put(record);
          await committed(transaction);
        },
        async roster() {
          const transaction = (await database()).transaction(CARDS, "readonly");
          const all = (await resultOf(
            transaction.objectStore(CARDS).index(BY_PROJECT).getAll(project),
          )) as CardRecord[];
          const manager = locks();
          const names = new Set(
            manager ? ((await manager.query()).held ?? []).map(({ name }) => name) : [],
          );
          const now = Date.now();
          const found: AgentRosterEntry[] = [];
          const old: string[] = [];
          for (const record of all) {
            if (held.has(record.id)) continue;
            const live = names.has(lockName(project, record.id));
            if (!live && now - record.at > AWAY_MS) {
              old.push(record.id);
              continue;
            }
            found.push({ id: record.id, card: record.card, live, at: record.at });
          }
          if (old.length > 0) {
            void (async () => {
              const cleaning = (await database()).transaction(CARDS, "readwrite");
              for (const id of old) cleaning.objectStore(CARDS).delete([project, id]);
              await committed(cleaning);
            })().catch(() => {});
          }
          return found;
        },
        async post(mail, { most, repeatMs }) {
          const transaction = (await database()).transaction(MAIL, "readwrite");
          const store = transaction.objectStore(MAIL);
          const now = Date.now();
          const waits = (await resultOf(
            store.index(BY_TO).getAll([project, mail.to]),
          )) as MailRecord[];
          const fresh = waits.filter((each) => now - each.at <= MAIL_MS);
          let result: "posted" | "full" | "repeat" = "posted";
          if (
            fresh.some(
              (each) =>
                each.from === mail.from && each.text === mail.text && now - each.at < repeatMs,
            )
          ) {
            result = "repeat";
          } else if (fresh.length >= most) result = "full";
          else store.add({ ...mail, project } satisfies MailRecord);
          await committed(transaction);
          if (result === "posted") tell({ project, kind: "mail", to: mail.to });
          return result;
        },
        async claim(to) {
          if (isOver) return [];
          // Which windows are there still: what one that went away took is free again.
          const names = await heldNow();
          const free = (record: MailRecord) =>
            record.claimedBy === undefined ||
            (record.claimedBy !== window && !names?.has(windowLock(record.claimedBy)));
          // Taken in one transaction: another window that claims the same waits for this one, and
          // finds them taken.
          const transaction = (await database()).transaction(MAIL, "readwrite");
          const store = transaction.objectStore(MAIL);
          const index = store.index(BY_TO);
          const keys = await resultOf(index.getAllKeys([project, to]));
          const all = (await resultOf(index.getAll([project, to]))) as MailRecord[];
          const now = Date.now();
          const found: PostedMail[] = [];
          all.forEach((record, at) => {
            const key = keys[at];
            if (key === undefined) return;
            if (now - record.at > MAIL_MS) {
              store.delete(key);
              return;
            }
            if (!free(record)) return;
            store.put({ ...record, claimedBy: window } satisfies MailRecord);
            const { project: _project, claimedBy: _claimedBy, ...mail } = record;
            found.push(mail);
          });
          await committed(transaction);
          for (const mail of found) taken.add(mail.id);
          return found.toSorted((a, b) => a.at - b.at);
        },
        done: dropAll,
        read(ids) {
          for (const id of ids) if (taken.has(id)) readHere.add(id);
        },
        unread(ids) {
          for (const id of ids) readHere.delete(id);
        },
        back: giveBack,
        want(id, take) {
          tell({ project, kind: "want", id, take });
        },
        yieldTo(id) {
          if (!held.get(id)?.owned) return;
          letGo(id);
          // In turn after the window that wants it.
          void hold(id, false);
        },
        gone(id) {
          tell({ project, kind: "gone", id });
        },
        answer(mail, outcome) {
          tell({ project, kind: "answer", mail, outcome });
        },
        outcome(mail, ms) {
          return new Promise<unknown>((resolve) => {
            const done = (outcome: unknown) => {
              clearTimeout(timer);
              waiting.delete(mail);
              resolve(outcome);
            };
            const timer = setTimeout(() => done(undefined), ms);
            waiting.set(mail, done);
          });
        },
        async watch(target, watcher, until) {
          const transaction = (await database()).transaction(WATCHES, "readwrite");
          const store = transaction.objectStore(WATCHES);
          const index = store.index(BY_TARGET);
          const keys = await resultOf(index.getAllKeys([project, target]));
          const all = (await resultOf(index.getAll([project, target]))) as WatchRecord[];
          const now = Date.now();
          // Those past their time go; of the rest, the newest so many, this one among them.
          const kept: { key: IDBValidKey; until: number }[] = [];
          all.forEach((record, at) => {
            const key = keys[at];
            if (key === undefined) return;
            if (record.until <= now || record.watcher === watcher) store.delete(key);
            else kept.push({ key, until: record.until });
          });
          const over = kept.length + 1 - MAX_WATCHERS;
          if (over > 0) {
            for (const { key } of kept.toSorted((a, b) => a.until - b.until).slice(0, over)) {
              store.delete(key);
            }
          }
          store.put({ project, target, watcher, until } satisfies WatchRecord);
          await committed(transaction);
        },
        async watchers(target) {
          const transaction = (await database()).transaction(WATCHES, "readwrite");
          const store = transaction.objectStore(WATCHES);
          const index = store.index(BY_TARGET);
          const keys = await resultOf(index.getAllKeys([project, target]));
          const all = (await resultOf(index.getAll([project, target]))) as WatchRecord[];
          for (const key of keys) store.delete(key);
          await committed(transaction);
          return all.map(({ watcher, until }) => ({ watcher, until }));
        },
        async forget(id) {
          const transaction = (await database()).transaction([CARDS, MAIL, WATCHES], "readwrite");
          transaction.objectStore(CARDS).delete([project, id]);
          const mail = transaction.objectStore(MAIL);
          for (const key of await resultOf(mail.index(BY_TO).getAllKeys([project, id]))) {
            mail.delete(key);
          }
          const watches = transaction.objectStore(WATCHES);
          for (const key of await resultOf(watches.index(BY_TARGET).getAllKeys([project, id]))) {
            watches.delete(key);
          }
          // Nor does it wait to be told of any other.
          const mine = (await resultOf(watches.getAll())) as WatchRecord[];
          for (const record of mine) {
            if (record.project === project && record.watcher === id) {
              watches.delete([project, record.target, record.watcher]);
            }
          }
          await committed(transaction);
        },
        budget: {
          get: readBudget,
          add: (count) => writeBudget(readBudget() + count),
          // People said something: also where the storage takes nothing, this window goes on.
          reset: () => {
            stored = { n: 0, at: Date.now() };
            writeBudget(0);
          },
        },
        close() {
          if (isOver) return;
          for (const id of Array.from(held.keys())) letGo(id);
          // What this window took and kept waits for whoever has those next; what was read goes.
          isOver = true;
          for (const done of waiting.values()) done(undefined);
          wire?.removeEventListener("message", onSignal as EventListener);
          wire?.close();
          unlisten();
          unhide();
          unshow();
          void leaving()
            .catch(() => {})
            .finally(() => leave());
        },
      };
    },
  };
}
