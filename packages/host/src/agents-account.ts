import type {
  AgentPost,
  AgentRoom,
  AgentRoomEvents,
  AgentRosterEntry,
  PostedMail,
} from "./agents.ts";
import type { PersonEventsAccess } from "./person-events.ts";

/** How long the platform has to answer, as `REQUEST_TIMEOUT_MS` of answers.ts. */
const REQUEST_TIMEOUT_MS = 20_000;

/** What `ask` comes to, or a rejection once it took longer than `ms`, its signal aborted then. */
async function withinTime<T>(ms: number, ask: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`No answer within ${ms} ms`));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([ask(controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The conversations and AI tools of a project of the platform, in the person's windows on any
 * computer, see `AgentPost` (chat6 technical design of AnimaQuill Cloud, 6.3): the backend keeps
 * which window has which (`/api/me/projects/:project/agents`, me/agents.ts of the server), what
 * they are, the messages that wait and who waits to be told, of the person only; its stream of
 * the person (`event: agents`, `PersonEventsAccess`) says at once that something came, and the
 * window asks every `HEARTBEAT_MS` besides, which also says it is still there. The same rules as
 * the windows of one browser have (agents-browser.ts), where a lock of the browser is a hold the
 * backend gives one window at a time, and lets go of once that window stops saying it is there.
 */

/** How often a window says it is there, and asks what there is for it. */
export const HEARTBEAT_MS = 30_000;
/** How often what a window says of what goes on in its ones goes, at most, unless they change. */
const CARDS_MS = 10_000;
/** How long a card stays as it is before the window says it again, so that it does not look old. */
const FRESH_MS = 60_000;
/** How long one taken with `tryServe` stays held before `serve` has to say it has it. */
const PINNED_MS = 5_000;
/** How long what the windows said of theirs is read again only as one of them changes. */
const ROSTER_MS = 10_000;
/** How long what was counted stays: as the backend has it. */
const AWAY_MS = 12 * 60 * 60 * 1000;

export interface AccountAgentsOptions {
  /** The address of a path of the platform's API, such as `/me/projects/…/agents`. */
  readonly api: (path: string) => string;
  /** Headers the platform asks of requests that change something. */
  readonly changeHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  /** The person's stream, which says at once that something came for them. */
  readonly events?: PersonEventsAccess;
  /**
   * The project on the platform a project of this window is, by what it is kept by here; undefined
   * while it is none (yet). Without it, the same.
   */
  readonly projectOf?: (key: string) => Promise<string | undefined>;
  readonly heartbeatMs?: number;
  /** Where the page goes away, see `pagehide`. */
  readonly listenPageHide?: (listener: () => void) => () => void;
  /** Where the page comes back from the browser's cache, see `pageshow` and `persisted`. */
  readonly listenPageShow?: (listener: () => void) => () => void;
  /**
   * Where the page may come back from a while without its timers (shown again, the network back),
   * see `visibilitychange` and `online`.
   */
  readonly listenWake?: (listener: () => void) => () => void;
}

/** What a request that outlives its page may carry, with room to spare, as `KEEPALIVE_BYTES`. */
const KEEPALIVE_BYTES = 60_000;
const fitsKeepalive = (body: string) => new TextEncoder().encode(body).byteLength < KEEPALIVE_BYTES;

/**
 * What goes to the platform, as it keeps it: without NUL, and with halves of UTF-16 pairs (as of an
 * emoji cut in two) made the replacement character; also in the names of fields.
 */
const cleaned = (value: unknown): unknown => {
  if (typeof value === "string") return value.replaceAll("\u0000", "").toWellFormed();
  if (Array.isArray(value)) return value.map(cleaned);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [cleaned(key) as string, cleaned(each)]),
    );
  return value;
};

/** The page's own events, where there is a page: also where this runs without one, as in tests. */
interface PageEvents {
  addEventListener?(
    type: string,
    listener: (event: { readonly persisted?: boolean }) => void,
  ): void;
  removeEventListener?(
    type: string,
    listener: (event: { readonly persisted?: boolean }) => void,
  ): void;
}
const page = globalThis as PageEvents;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

const newWindowId = () =>
  `w-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36)}`;

/** A count of turns nobody was there for, and when it was written. */
interface Count {
  readonly n: number;
  readonly at: number;
}

/** A message as the backend gives it back, or undefined where it is not one. */
function postedOf(value: unknown): PostedMail | undefined {
  if (!isRecord(value)) return undefined;
  const { id, to, from, text, at, left, body } = value;
  if (typeof id !== "string" || typeof to !== "string" || typeof from !== "string") {
    return undefined;
  }
  if (typeof text !== "string" || typeof at !== "number" || typeof left !== "boolean") {
    return undefined;
  }
  return { id, to, from, text, at, left, body };
}

export type {
  AgentPost,
  AgentRoom,
  AgentRoomEvents,
  AgentRosterEntry,
  PostedMail,
} from "./agents.ts";
export type { PersonEventsAccess } from "./person-events.ts";

export function accountAgents(options: AccountAgentsOptions): AgentPost {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const listenPageHide =
    options.listenPageHide ??
    ((listener) => {
      if (!page.addEventListener) return () => {};
      page.addEventListener("pagehide", listener);
      return () => page.removeEventListener?.("pagehide", listener);
    });
  const listenWake =
    options.listenWake ??
    ((listener) => {
      if (!page.addEventListener) return () => {};
      page.addEventListener("visibilitychange", listener);
      page.addEventListener("online", listener);
      return () => {
        page.removeEventListener?.("visibilitychange", listener);
        page.removeEventListener?.("online", listener);
      };
    });
  const listenPageShow =
    options.listenPageShow ??
    ((listener) => {
      if (!page.addEventListener) return () => {};
      const shown = (event: { readonly persisted?: boolean }) => {
        if (event.persisted) listener();
      };
      page.addEventListener("pageshow", shown);
      return () => page.removeEventListener?.("pageshow", shown);
    });

  return {
    reach: "account",
    enter(project, events: AgentRoomEvents): AgentRoom {
      const window = newWindowId();
      const base = "";
      const windowPath = `/windows/${window}`;
      /** The project on the platform, once it is one. */
      let onPlatform: string | undefined;
      const placeOf = async () => {
        if (onPlatform !== undefined) return onPlatform;
        const found = options.projectOf ? await options.projectOf(project) : project;
        if (found === undefined) throw new Error("The project is not on the platform (yet)");
        onPlatform = found;
        return found;
      };
      /** Asks the backend; what it answered, or throws where it could not, or said no. */
      const ask = (
        path: string,
        body?: unknown,
        how: { readonly method?: string; readonly keepalive?: boolean } = {},
      ) =>
        withinTime(REQUEST_TIMEOUT_MS, async (signal) => {
          const at = `/me/projects/${encodeURIComponent(await placeOf())}/agents${path}`;
          const text = body === undefined ? undefined : JSON.stringify(cleaned(body));
          const response = await request(options.api(at), {
            cache: "no-store",
            method: how.method ?? (body === undefined ? "GET" : "POST"),
            signal,
            ...(text !== undefined && {
              headers: { ...options.changeHeaders, "content-type": "application/json" },
              body: text,
              keepalive: how.keepalive === true && fitsKeepalive(text),
            }),
          });
          const answer: unknown =
            response.status === 204 ? {} : await response.json().catch(() => undefined);
          return { status: response.status, ok: response.ok, answer };
        });
      const said = async (
        path: string,
        body?: unknown,
        how?: { readonly method?: string; readonly keepalive?: boolean },
      ) => {
        const { ok, status, answer } = await ask(path, body, how);
        if (!ok || !isRecord(answer)) throw new Error(`The platform answered ${status}`);
        return answer;
      };

      let isOver = false;
      /** The page went: it took part no more, until it comes back from the browser's cache. */
      let away = false;
      /** It came back since: the platform is told so, as it took it for gone. */
      let rejoin = false;
      /** Which time of its page this is: one more each time it comes back, see `again`. */
      let generation = 0;
      /** Those this window has or asks for, and when one taken with `tryServe` was. */
      const wanted = new Map<string, number | undefined>();
      const owned = new Set<string>();
      const waits = new Set<string>();
      /** Those it had, then lost (it was not there for a while): another may have changed them. */
      const lost = new Set<string>();
      /** What this window says of those it has, and what it last sent, when. */
      let cards: readonly { readonly id: string; readonly card: unknown }[] = [];
      let sentCards = "";
      let sentShape = "";
      let sentAt = 0;
      const waiting = new Map<string, (outcome: unknown) => void>();
      /** The messages this window took and has, and of those, the ones a conversation read. */
      const taken = new Set<string>();
      const readHere = new Set<string>();
      /** What the windows said last, as this one read it, and what it counted itself. */
      let stored: Count = { n: 0, at: 0 };
      let own: Count = stored;
      const counting = (count: Count) => (Date.now() - count.at > AWAY_MS ? 0 : count.n);
      const readBudget = () => Math.max(counting(stored), counting(own));
      const heard = (count: Count) => {
        if (count.at >= stored.at) stored = count;
      };
      let roster:
        | {
            readonly at: number;
            readonly found: Promise<{ entries: AgentRosterEntry[]; held: Set<string> }>;
          }
        | undefined;

      /** Of the wanted ones, those that still go: one taken a moment ago stays a while. */
      const serving = () => {
        const now = Date.now();
        for (const [id, pinned] of Array.from(wanted)) {
          if (pinned !== undefined && now - pinned >= PINNED_MS) wanted.delete(id);
        }
        return [...wanted.keys()];
      };
      const shapeOf = (list: typeof cards) =>
        JSON.stringify(
          list.map(({ id, card }) => {
            const { state, name, accepts } = isRecord(card) ? card : {};
            return [id, state, name, accepts];
          }),
        );

      /**
       * What the platform keeps of which this window has goes one request at a time, each with what
       * the window wants as it goes: one sent before another came back would undo it.
       */
      let turn: Promise<unknown> = Promise.resolve();
      const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
        const next = turn.then(work, work);
        turn = next.catch(() => {});
        return next;
      };
      /** Whether this window still takes part: not closed, nor its page gone. */
      const going = () => !isOver && !away;
      let syncing: Promise<void> | undefined;
      let again = false;
      /** Says what this window has and asks what there is for it; once at a time, again after. */
      const sync = (): Promise<void> => {
        if (isOver || away) return Promise.resolve();
        if (syncing) {
          again = true;
          return syncing;
        }
        syncing = (async () => {
          do {
            again = false;
            await inTurn(syncOnce).catch((error: unknown) => {
              console.warn("The platform could not be told what this window has", error);
            });
          } while (again && going());
        })().finally(() => {
          syncing = undefined;
        });
        return syncing;
      };
      const syncOnce = async () => {
        const serve = serving();
        const now = Date.now();
        const mine = cards.filter(({ id }) => owned.has(id) && wanted.has(id));
        const text = JSON.stringify(mine);
        const shape = shapeOf(mine);
        const sendCards =
          shape !== sentShape ||
          (text !== sentCards && now - sentAt >= CARDS_MS) ||
          now - sentAt >= FRESH_MS;
        const coming = rejoin;
        const {
          ok,
          status,
          answer: reply,
        } = await ask(
          windowPath,
          {
            serve,
            // What a conversation read of what it took goes, as it lets go of one.
            read: [...readHere].slice(-200),
            ...(sendCards && { cards: mine }),
            ...(coming && { again: true, generation }),
          },
          { method: "PUT" },
        );
        if (isOver || away) return;
        // It went as the page did, and is back: it says so.
        if (status === 409 && isRecord(reply) && reply.error === "left") {
          rejoin = true;
          again = true;
          return;
        }
        if (!ok || !isRecord(reply)) throw new Error(`The platform answered ${status}`);
        const answer = reply;
        if (coming) rejoin = false;
        if (sendCards) {
          sentCards = text;
          sentShape = shape;
          sentAt = now;
        }
        const nowOwned = new Set(strings(answer.owned));
        const nowWaits = new Set(strings(answer.waits));
        const first = new Set<string>();
        for (const id of nowOwned) {
          if (owned.has(id) || !wanted.has(id)) continue;
          owned.add(id);
          first.add(id);
          const waited = waits.has(id) || lost.has(id);
          lost.delete(id);
          waits.delete(id);
          events.owned(id, waited);
        }
        for (const id of Array.from(owned)) {
          if (nowOwned.has(id)) continue;
          owned.delete(id);
          if (!wanted.has(id)) continue;
          lost.add(id);
          // Another window has it now: what goes on in it here stops.
          events.lost?.(id);
        }
        for (const id of nowWaits) {
          if (!wanted.has(id) || waits.has(id)) continue;
          waits.add(id);
          events.queued?.(id);
        }
        for (const id of Array.from(waits)) if (!nowWaits.has(id)) waits.delete(id);
        // What it now has with cards it said nothing of yet goes again in a moment.
        if (first.size > 0 && cards.some(({ id }) => first.has(id))) sentShape = "";
        if (isRecord(answer.budget)) {
          const { count, at } = answer.budget;
          if (typeof count === "number" && typeof at === "number") heard({ n: count, at });
        }
        for (const to of strings(answer.mail)) if (owned.has(to)) events.mail(to);
      };
      const syncSoon = () => {
        queueMicrotask(() => void sync());
      };

      const onAgents = (data: unknown) => {
        if (isOver || away || !isRecord(data)) return;
        if (data.k === "missed") {
          roster = undefined;
          void sync();
          return;
        }
        if (onPlatform === undefined || data.p !== onPlatform) return;
        // What this window said itself it knows.
        if (data.w === window && data.k !== "owned") return;
        switch (data.k) {
          case "mail":
            if (typeof data.to === "string" && owned.has(data.to)) events.mail(data.to);
            break;
          case "owned":
            if (data.w === window) void sync();
            roster = undefined;
            break;
          case "cards":
            roster = undefined;
            break;
          case "want":
            if (typeof data.id === "string" && owned.has(data.id)) {
              events.wanted?.(data.id, data.take === true);
            }
            break;
          case "gone":
            if (typeof data.id === "string" && wanted.has(data.id)) events.gone?.(data.id);
            break;
          case "answer":
            if (typeof data.mail === "string") waiting.get(data.mail)?.(data.outcome);
            break;
          case "budget":
            if (typeof data.count === "number" && typeof data.at === "number") {
              // What all windows say goes: also people saying something there.
              stored = { n: data.count, at: data.at };
              own = stored;
              events.budget();
            }
            break;
        }
      };
      const unwatch =
        options.events?.watch(
          () => {},
          (live) => {
            // Back after a while without it: what was missed meanwhile.
            if (live) {
              roster = undefined;
              void sync();
            }
          },
          onAgents,
        ) ?? (() => {});
      // Said every while; where much more went by between two (asleep, its timers held back), the
      // platform may have taken it for gone: what it has is asked at once, and so as the page is
      // shown again or the network is back.
      let beatAt = Date.now();
      const beat = setInterval(() => {
        beatAt = Date.now();
        void sync();
      }, heartbeatMs);
      const unwake = listenWake(() => {
        if (isOver || away) return;
        if (Date.now() - beatAt > heartbeatMs) {
          beatAt = Date.now();
          void sync();
        }
      });

      /** As the page or the room goes: what a conversation read goes, the rest goes back. */
      const leave = (keepCards: boolean) => {
        const read = [...taken].filter((id) => readHere.has(id));
        taken.clear();
        readHere.clear();
        owned.clear();
        waits.clear();
        return said(
          `${windowPath}/leave`,
          { read, keepCards, generation },
          { keepalive: true },
        ).catch(() => {});
      };
      const unhide = listenPageHide(() => {
        if (isOver || away) return;
        away = true;
        // Those it had may change meanwhile: as it comes back, read again (`waited`).
        for (const id of wanted.keys()) lost.add(id);
        sentShape = "";
        void leave(true);
      });
      const unshow = listenPageShow(() => {
        if (isOver || !away) return;
        away = false;
        rejoin = true;
        generation += 1;
        events.resumed?.();
        void sync();
      });

      const fetchRoster = () => {
        const found = said(base).then((answer) => {
          const entries: AgentRosterEntry[] = [];
          for (const each of Array.isArray(answer.agents) ? answer.agents : []) {
            if (!isRecord(each) || typeof each.id !== "string") continue;
            entries.push({
              id: each.id,
              card: each.card,
              live: each.live === true,
              at: typeof each.at === "number" ? each.at : 0,
            });
          }
          return { entries, held: new Set(strings(answer.held)) };
        });
        const made = { at: Date.now(), found };
        roster = made;
        found.catch(() => {
          if (roster === made) roster = undefined;
        });
        return found;
      };

      return {
        serve(ids) {
          if (isOver) return;
          const next = new Set(ids);
          let changed = false;
          const now = Date.now();
          for (const [id, pinned] of Array.from(wanted)) {
            if (next.has(id)) {
              if (pinned !== undefined) wanted.set(id, undefined);
              continue;
            }
            if (pinned !== undefined && now - pinned < PINNED_MS) continue;
            wanted.delete(id);
            owned.delete(id);
            waits.delete(id);
            lost.delete(id);
            changed = true;
          }
          for (const id of next) {
            if (wanted.has(id)) continue;
            wanted.set(id, undefined);
            changed = true;
          }
          if (changed) syncSoon();
        },
        async tryServe(id) {
          if (isOver || away) return false;
          if (wanted.has(id)) return owned.has(id);
          const answer = await inTurn(async () => {
            const held = await said(`${windowPath}/hold`, { agent: id }).catch(() => undefined);
            // Wanted at once, before anything else goes, so that nothing lets go of it.
            if (!isOver && held?.owned === true) {
              wanted.set(id, Date.now());
              owned.add(id);
            }
            return held;
          });
          if (isOver || answer?.owned !== true) return false;
          queueMicrotask(() => !isOver && owned.has(id) && events.owned(id, false));
          return true;
        },
        owns: (id) => owned.has(id),
        async held(id) {
          if (owned.has(id)) return true;
          return (await fetchRoster()).held.has(id);
        },
        async publish(list) {
          if (isOver) return;
          cards = list;
          const mine = list.filter(({ id }) => owned.has(id));
          const text = JSON.stringify(mine);
          const now = Date.now();
          if (
            shapeOf(mine) !== sentShape ||
            (text !== sentCards && now - sentAt >= CARDS_MS) ||
            now - sentAt >= FRESH_MS
          ) {
            await sync();
          }
        },
        async roster(fresh) {
          const kept = roster;
          const found =
            !fresh && kept && Date.now() - kept.at < ROSTER_MS ? kept.found : fetchRoster();
          const { entries } = await found;
          return entries.filter((entry) => !wanted.has(entry.id));
        },
        async post(mail, { most, repeatMs }) {
          const { ok, status, answer } = await ask(`${base}/mail`, { mail, most, repeatMs });
          // Too many sent of late: as many as wait already, for whoever sent it.
          if (status === 429) return "full";
          if (!ok || !isRecord(answer)) throw new Error(`The platform answered ${status}`);
          const result = answer.result;
          if (result !== "posted" && result !== "full" && result !== "repeat") {
            throw new Error("The platform answered something that cannot be read");
          }
          return result;
        },
        async claim(to) {
          if (isOver || away || !owned.has(to)) return [];
          const answer = await said(`${windowPath}/claim`, { agent: to });
          const found: PostedMail[] = [];
          for (const each of Array.isArray(answer.mail) ? answer.mail : []) {
            const mail = postedOf(each);
            if (!mail) continue;
            taken.add(mail.id);
            found.push(mail);
          }
          return found.toSorted((a, b) => a.at - b.at);
        },
        async done(ids) {
          if (ids.length === 0) return;
          for (const id of ids) {
            taken.delete(id);
            readHere.delete(id);
          }
          await said(`${windowPath}/done`, { ids });
        },
        read(ids) {
          for (const id of ids) if (taken.has(id)) readHere.add(id);
        },
        unread(ids) {
          for (const id of ids) readHere.delete(id);
        },
        async back(ids) {
          if (ids.length === 0) return;
          for (const id of ids) taken.delete(id);
          await said(`${windowPath}/back`, { ids });
        },
        want(id, take) {
          void said(`${base}/signal`, { window, kind: "want", id, take }).catch(() => {});
        },
        yieldTo(id) {
          if (!owned.has(id)) return;
          void inTurn(() =>
            said(`${windowPath}/yield`, { agent: id, read: [...readHere].slice(-200) }),
          )
            .then((answer) => {
              if (isOver || !wanted.has(id)) return;
              if (answer.owned === true) {
                // Nobody waits for it after all: it stays here.
                events.owned(id, false);
                return;
              }
              owned.delete(id);
              waits.add(id);
              events.queued?.(id);
            })
            .catch(() => {});
        },
        gone(id) {
          void said(`${base}/signal`, { window, kind: "gone", id }).catch(() => {});
        },
        answer(mail, outcome) {
          void said(`${base}/signal`, { window, kind: "answer", mail, outcome }).catch(() => {});
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
          await said(`${base}/watch`, { target, watcher, until });
        },
        async watchers(target) {
          const answer = await said(`${base}/watchers`, { target });
          return (Array.isArray(answer.watchers) ? answer.watchers : []).flatMap((each) =>
            isRecord(each) && typeof each.watcher === "string" && typeof each.until === "number"
              ? [{ watcher: each.watcher, until: each.until }]
              : [],
          );
        },
        async forget(id) {
          await said(`${base}/forget`, { agent: id });
        },
        budget: {
          get: readBudget,
          add(count) {
            own = { n: readBudget() + count, at: Date.now() };
            void said(`${base}/budget`, { window, add: Math.min(100, Math.max(1, count)) })
              .then((answer) => {
                if (typeof answer.count === "number" && typeof answer.at === "number") {
                  heard({ n: answer.count, at: answer.at });
                }
              })
              .catch(() => {});
          },
          // People said something: also where the platform cannot be told, this window goes on.
          reset() {
            stored = { n: 0, at: Date.now() };
            own = stored;
            void said(`${base}/budget`, { window, reset: true }).catch(() => {});
          },
        },
        close() {
          if (isOver) return;
          const wasAway = away;
          isOver = true;
          clearInterval(beat);
          unwatch();
          unhide();
          unshow();
          unwake();
          for (const done of waiting.values()) done(undefined);
          // What this window took and kept waits for whoever has those next; what was read goes.
          if (!wasAway) void leave(false);
          wanted.clear();
        },
      };
    },
  };
}
