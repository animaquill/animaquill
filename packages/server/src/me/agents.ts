import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AccessGate } from "../access.ts";
import type { Accounts } from "../auth/accounts.ts";
import type { SessionCredentials } from "../auth/credentials.ts";
import { fromThisSite } from "../auth/guard.ts";
import { Limits, RateLimit } from "../auth/limits.ts";
import { signedInWith } from "../auth/signed-in.ts";
import {
  describeError,
  retryOnDeadlock,
  type Db,
  type Executor,
  type Logger,
  type Tx,
} from "../database.ts";
import type { Jobs } from "../jobs.ts";
import {
  agentBudgets,
  agentCards,
  agentHolds,
  agentMail,
  agentWatches,
  agentWindows,
} from "../schema.ts";
import { listenToChannel } from "../sync/channel-listener.ts";
import type { PersonEvents } from "./events.ts";

/**
 * What the conversations and AI tools of a person's project, in their windows on any computer, say
 * to each other (docs/design/ai-teamwork.md of AnimaQuill Cloud, 3; chat6 technical design, 6.3):
 * the online `AgentPost` of the editor's host (agents-account.ts there), as the browser's
 * (agents-browser.ts) is for the windows of one browser. The same rules, kept here: one window at a
 * time has a conversation (`holds`), and the others wait for it in turn; a message waits until the
 * window that has the one it is for takes it, which only one can, and has it until it says it is
 * done with it or gives it back, or goes. What a card, a message or an answer says is for the
 * editor to read: this keeps and carries it, of a size, and nothing else.
 *
 * Everything is of the person signed in, about a project they may read (`AccessPolicy`, the route's
 * `config.access`): every row has their id, every query asks for it, and nothing of anyone else's
 * is ever read or told, also where others may read the same project. Said to the person's pages at
 * once over their stream (me/events.ts, `event: agents`), and where a page misses that, with what
 * it asks every half minute.
 *
 * Under `/api/me/projects/:project/agents`, JSON; changes only from pages of this site; errors
 * `{error}`: signedOut (401), forbidden (403), notFound (404, also for a project the person may
 * not read), invalid (400), tooLarge (413), busy (429), unavailable (503).
 *
 * - `PUT …/windows/:window` `{serve, cards?, again?}`: the window is there (for `WINDOW_MS`), has these
 *   (`serve`, at most `MOST_SERVED`), and says this of those it has (`cards`, `[{id, card}]`, each at
 *   most `CARD_BYTES`; left out: as before). 200 `{owned, waits, mail, budget}`: which it has now,
 *   which it waits for, which of those it has have messages nobody took, and the count of turns. 409
 *   `left` for one that went, unless it says it comes back (`again`).
 * - `POST …/windows/:window/leave` `{read?, keepCards?}`: it goes: what it had goes to whoever waits
 *   for it, the messages it took go back (those it `read` go), and what it said of them goes unless
 *   `keepCards` (a page that goes away, whose conversations are away then). 204.
 * - `POST …/windows/:window/hold` `{agent}`: has one right away where no window does. `{owned}`.
 * - `POST …/windows/:window/yield` `{agent}`: lets go of one for the window that waits for it, and
 *   waits for it after that one. `{owned}`: still its own where none waits.
 * - `POST …/windows/:window/claim` `{agent}`: takes the messages for one it has. `{mail}`.
 * - `POST …/windows/:window/done` `{ids}`, `…/back` `{ids}`: messages it took, gone or back. 204.
 * - `GET …/agents`: `{agents: [{id, card, live, at}], held}`, what the windows said of those they
 *   have or had within `AWAY_MS`, and which any window has now.
 * - `POST …/mail` `{mail, most, repeatMs}`: leaves a message. `{result: "posted" | "full" |
 *   "repeat"}`. `MOST_WAITING` for one at most, `MOST_MAIL` of a project, `SENDS_PER_MINUTE`.
 * - `POST …/signal` `{window, kind: "want" | "gone" | "answer", …}`: tells the person's other
 *   windows.
 * - `POST …/watch` `{target, watcher, until}`, `POST …/watchers` `{target}`: who waits to be told
 *   that one is idle, and taking them. `POST …/forget` `{agent}`: one deleted.
 * - `POST …/budget` `{add}` or `{reset: true}`, and the window: `{count, at}`.
 */

/** The channel of PostgreSQL that what is said of agents goes over to every process. */
export const AGENTS_CHANNEL = "person_agents";
/** How long a window is there after it last said so: it says so every half minute. */
export const WINDOW_MS = 90_000;
/** How long what a window said of one it had is listed after it went, and a count counts. */
export const AWAY_MS = 12 * 60 * 60_000;
/** How long a message waits at most. */
export const MAIL_MS = 7 * 24 * 60 * 60_000;
/** How long one waits to be told another is idle, at most. */
export const WATCH_MS = 12 * 60 * 60_000;
/** Those one window has at most, and windows of a person on a project. */
export const MOST_SERVED = 100;
export const MOST_WINDOWS = 32;
/** Cards of a person on a project at most. */
export const MOST_CARDS = 100;
/** Bytes of what is said of one at most, as JSON. */
export const CARD_BYTES = 4096;
/** Messages that wait for one at most, and for all of a project. */
export const MOST_WAITING = 50;
export const MOST_MAIL = 1000;
/** Characters of a message at most, as the tools take them (`MAX_MESSAGE`). */
export const MESSAGE_CHARS = 4000;
/** Bytes of a message with all it carries, as JSON. */
export const MAIL_BYTES = 32 * 1024;
/** How long the same words from the same one go once, at most. */
export const REPEAT_MS = 60_000;
/** Who waits to be told of one at most. */
export const MOST_WATCHERS = 50;
/** Messages one person sends in a minute at most. */
export const SENDS_PER_MINUTE = 60;
/** Bytes of what a window says came of a message at most. */
const ANSWER_BYTES = 1024;
/** Ids in one request at most. */
const MOST_IDS = 200;

/** A lock of a person's project, for what is had and taken there: one at a time. */
const AGENTS_LOCK = 0x61712d61; // "aq-a"

export const WINDOW_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A conversation's id, `mcp:` and a session for an AI tool, a message's id. */
export const AGENT_ID = /^[\x21-\x7e]{1,200}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isAgent = (value: unknown): value is string =>
  typeof value === "string" && AGENT_ID.test(value);
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
const idsOf = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.length > MOST_IDS || !value.every(isAgent)) return undefined;
  return [...new Set(value)];
};

/** What is said to the person's pages, see me/events.ts: of one project, and what of it. */
export type AgentsSaid =
  | { readonly k: "mail"; readonly to: string }
  | { readonly k: "owned"; readonly w: string; readonly id: string }
  | { readonly k: "cards" }
  | { readonly k: "want"; readonly w: string; readonly id: string; readonly take: boolean }
  | { readonly k: "gone"; readonly w: string; readonly id: string }
  | { readonly k: "answer"; readonly w: string; readonly mail: string; readonly outcome: unknown }
  | {
      readonly k: "budget";
      readonly w: string | undefined;
      readonly count: number;
      readonly at: number;
    };

/** Tells the person's pages, once `db`'s transaction commits. */
const tell = async (db: Executor, userId: string, project: string, said: AgentsSaid) => {
  await db.execute(
    sql`select pg_notify(${AGENTS_CHANNEL}, ${JSON.stringify({ u: userId, p: project, ...said })})`,
  );
};

/** Hears what any process says on `AGENTS_CHANNEL`, see `listenToChannel`. */
export const listenForAgents = (db: Db, events: PersonEvents, log: Logger) =>
  listenToChannel(
    db,
    AGENTS_CHANNEL,
    {
      heard: (payload) => {
        let found: unknown;
        try {
          found = JSON.parse(payload);
        } catch {
          return;
        }
        if (!isRecord(found) || typeof found.u !== "string") return;
        const { u, ...rest } = found;
        events.agents(u, JSON.stringify(rest));
      },
      missed: async () => events.agentsMissed(),
    },
    log,
  );

const locked = async (tx: Tx, userId: string, project: string) => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${AGENTS_LOCK}, hashtext(${`${userId}/${project}`}))`,
  );
};

/** In a transaction that has the person's project to itself. */
const inProject = <T>(db: Db, userId: string, project: string, work: (tx: Tx) => Promise<T>) =>
  retryOnDeadlock(() =>
    db.transaction(async (tx) => {
      await locked(tx, userId, project);
      return work(tx);
    }),
  );

interface Place {
  readonly userId: string;
  readonly project: string;
}

/** The windows of the person's project there now, besides this one if said. */
const liveWindows = async (tx: Tx, { userId, project }: Place, now: Date) =>
  new Set(
    (
      await tx
        .select({ id: agentWindows.windowId })
        .from(agentWindows)
        .where(
          and(
            eq(agentWindows.userId, userId),
            eq(agentWindows.projectId, project),
            gt(agentWindows.liveUntil, now),
          ),
        )
    ).map((row) => row.id),
  );

/** Who has which of these, and who waits, the first first. */
const holdsOf = async (tx: Tx, { userId, project }: Place, agents: readonly string[]) =>
  agents.length === 0
    ? []
    : tx
        .select({
          agent: agentHolds.agentId,
          window: agentHolds.windowId,
          holds: agentHolds.holds,
          since: agentHolds.since,
        })
        .from(agentHolds)
        .where(
          and(
            eq(agentHolds.userId, userId),
            eq(agentHolds.projectId, project),
            inArray(agentHolds.agentId, agents),
          ),
        )
        .orderBy(asc(agentHolds.since), asc(agentHolds.windowId));

const holdsWhere = ({ userId, project }: Place, agent: string, window: string) =>
  and(
    eq(agentHolds.userId, userId),
    eq(agentHolds.projectId, project),
    eq(agentHolds.agentId, agent),
    eq(agentHolds.windowId, window),
  );

/**
 * Who has one now, as it stands: where the window that had it went, the first of those that wait
 * and are there has it, told so. Its window, or undefined where nobody has it.
 */
const settle = async (
  tx: Tx,
  place: Place,
  agent: string,
  rows: readonly { window: string; holds: boolean }[],
  live: ReadonlySet<string>,
  now: Date,
): Promise<string | undefined> => {
  const holder = rows.find((row) => row.holds);
  if (holder && live.has(holder.window)) return holder.window;
  if (holder) await tx.delete(agentHolds).where(holdsWhere(place, agent, holder.window));
  const next = rows.find((row) => !row.holds && live.has(row.window));
  if (!next) return undefined;
  await give(tx, place, agent, next.window, now);
  return next.window;
};

/** One goes to a window that waited for it, which is told. */
const give = async (tx: Tx, place: Place, agent: string, window: string, now: Date) => {
  await tx
    .update(agentHolds)
    .set({ holds: true, since: now })
    .where(holdsWhere(place, agent, window));
  await tell(tx, place.userId, place.project, { k: "owned", w: window, id: agent });
  await tell(tx, place.userId, place.project, { k: "cards" });
};

/** A window lets go of one it has: the first of those that wait and are there has it then. */
const letGo = async (tx: Tx, place: Place, agent: string, window: string, now: Date) => {
  await tx.delete(agentHolds).where(holdsWhere(place, agent, window));
  const live = await liveWindows(tx, place, now);
  const rows = await holdsOf(tx, place, [agent]);
  const next = rows.find((row) => !row.holds && live.has(row.window));
  if (next) await give(tx, place, agent, next.window, now);
  else await tell(tx, place.userId, place.project, { k: "cards" });
};

const waitFor = async (
  tx: Tx,
  { userId, project }: Place,
  agent: string,
  window: string,
  now: Date,
) => {
  await tx
    .insert(agentHolds)
    .values({
      userId,
      projectId: project,
      agentId: agent,
      windowId: window,
      holds: false,
      since: now,
    })
    .onConflictDoNothing();
};

const take = async (
  tx: Tx,
  { userId, project }: Place,
  agent: string,
  window: string,
  now: Date,
) => {
  await tx
    .insert(agentHolds)
    .values({
      userId,
      projectId: project,
      agentId: agent,
      windowId: window,
      holds: true,
      since: now,
    })
    .onConflictDoUpdate({
      target: [agentHolds.userId, agentHolds.projectId, agentHolds.agentId, agentHolds.windowId],
      set: { holds: true, since: now },
    });
};

/** When a window that went is said to be there till: gone, and not to come back unless it says so. */
const LEFT = new Date(0);

/**
 * The window is there for a while yet; "busy" where the person has as many as they may; "left"
 * where it went (`leaveWindow`) and does not say it comes back (`again`, as a page does that comes
 * back from the browser's cache): a request it sent before it went, that came after, does nothing.
 */
const beThere = async (tx: Tx, place: Place, window: string, now: Date, again = false) => {
  const [row] = await tx
    .select({ liveUntil: agentWindows.liveUntil })
    .from(agentWindows)
    .where(
      and(
        eq(agentWindows.userId, place.userId),
        eq(agentWindows.projectId, place.project),
        eq(agentWindows.windowId, window),
      ),
    );
  if (row?.liveUntil.getTime() === LEFT.getTime() && !again) return "left" as const;
  const live = await liveWindows(tx, place, now);
  if (!live.has(window) && live.size >= MOST_WINDOWS) return "busy" as const;
  await tx
    .insert(agentWindows)
    .values({
      userId: place.userId,
      projectId: place.project,
      windowId: window,
      liveUntil: new Date(now.getTime() + WINDOW_MS),
    })
    .onConflictDoUpdate({
      target: [agentWindows.userId, agentWindows.projectId, agentWindows.windowId],
      set: { liveUntil: new Date(now.getTime() + WINDOW_MS) },
    });
  live.add(window);
  return live;
};

const budgetOf = async (tx: Executor, { userId, project }: Place, now: Date) => {
  const [row] = await tx
    .select({ count: agentBudgets.count, at: agentBudgets.at })
    .from(agentBudgets)
    .where(and(eq(agentBudgets.userId, userId), eq(agentBudgets.projectId, project)));
  if (!row || now.getTime() - row.at.getTime() > AWAY_MS) return { count: 0, at: 0 };
  return { count: row.count, at: row.at.getTime() };
};

/** Messages nobody has: not taken, or taken by a window that went. */
const free = (place: Place, window: string, live: ReadonlySet<string>) =>
  and(
    eq(agentMail.userId, place.userId),
    eq(agentMail.projectId, place.project),
    or(
      isNull(agentMail.claimedBy),
      and(ne(agentMail.claimedBy, window), notInArray(agentMail.claimedBy, [...live])),
    ),
  );

export interface WindowSay {
  readonly serve: readonly string[];
  /** It went, and comes back: see `beThere`. */
  readonly again?: boolean;
  readonly cards?: readonly { readonly id: string; readonly card: Record<string, unknown> }[];
}

export const windowSayOf = (body: unknown): WindowSay | "tooLarge" | undefined => {
  if (!isRecord(body) || !Array.isArray(body.serve)) return undefined;
  if (body.serve.length > MOST_SERVED || !body.serve.every(isAgent)) return undefined;
  const serve = [...new Set(body.serve as string[])];
  if (body.again !== undefined && typeof body.again !== "boolean") return undefined;
  const again = body.again === true;
  if (body.cards === undefined) return { serve, again };
  if (!Array.isArray(body.cards) || body.cards.length > MOST_SERVED) return undefined;
  const cards: { id: string; card: Record<string, unknown> }[] = [];
  for (const each of body.cards) {
    if (!isRecord(each) || !isAgent(each.id) || !isRecord(each.card)) return undefined;
    if (bytesOf(each.card) > CARD_BYTES) return "tooLarge";
    cards.push({ id: each.id, card: each.card });
  }
  return { serve, again, cards };
};

/**
 * A window says it is there and has these: of those, which it has now, which it waits for in turn
 * after another window, and which have messages nobody took; what it said of those it has.
 */
export const sayWindow = (db: Db, place: Place, window: string, say: WindowSay, now: Date) =>
  inProject(db, place.userId, place.project, async (tx) => {
    const live = await beThere(tx, place, window, now, say.again === true);
    if (live === "busy" || live === "left") return live;
    // Those it does not have any more go, to whoever waits for them.
    const mine = await tx
      .select({ agent: agentHolds.agentId, holds: agentHolds.holds })
      .from(agentHolds)
      .where(
        and(
          eq(agentHolds.userId, place.userId),
          eq(agentHolds.projectId, place.project),
          eq(agentHolds.windowId, window),
        ),
      );
    const wanted = new Set(say.serve);
    for (const row of mine) {
      if (wanted.has(row.agent)) continue;
      if (row.holds) {
        await letGo(tx, place, row.agent, window, now);
        await dropCard(tx, place, row.agent, window);
      } else await tx.delete(agentHolds).where(holdsWhere(place, row.agent, window));
    }
    const rows = await holdsOf(tx, place, say.serve);
    const owned: string[] = [];
    const waits: string[] = [];
    for (const agent of say.serve) {
      const of = rows.filter((row) => row.agent === agent);
      const holder = await settle(tx, place, agent, of, live, now);
      if (holder === window) owned.push(agent);
      else if (holder === undefined) {
        await take(tx, place, agent, window, now);
        await tell(tx, place.userId, place.project, { k: "cards" });
        owned.push(agent);
      } else {
        await waitFor(tx, place, agent, window, now);
        waits.push(agent);
      }
    }
    if (say.cards) await writeCards(tx, place, window, say.cards, new Set(owned), now);
    const waiting =
      owned.length === 0
        ? []
        : await tx
            .selectDistinct({ to: agentMail.toAgent })
            .from(agentMail)
            .where(
              and(
                free(place, window, live),
                inArray(agentMail.toAgent, owned),
                gt(agentMail.expiresAt, now),
              ),
            );
    return {
      owned,
      waits,
      mail: waiting.map((row) => row.to),
      budget: await budgetOf(tx, place, now),
    };
  });

const dropCard = async (tx: Tx, { userId, project }: Place, agent: string, window: string) => {
  await tx
    .delete(agentCards)
    .where(
      and(
        eq(agentCards.userId, userId),
        eq(agentCards.projectId, project),
        eq(agentCards.agentId, agent),
        eq(agentCards.windowId, window),
      ),
    );
};

/** What a window says of those it has: the others are told where one came or its state changed. */
const writeCards = async (
  tx: Tx,
  place: Place,
  window: string,
  cards: readonly { readonly id: string; readonly card: Record<string, unknown> }[],
  owned: ReadonlySet<string>,
  now: Date,
) => {
  const ours = cards.filter((each) => owned.has(each.id));
  if (ours.length === 0) return;
  const before = await tx
    .select({ agent: agentCards.agentId, card: agentCards.card })
    .from(agentCards)
    .where(and(eq(agentCards.userId, place.userId), eq(agentCards.projectId, place.project)));
  const had = new Map(before.map((row) => [row.agent, row.card]));
  const fresh = ours.filter((each) => !had.has(each.id));
  if (had.size + fresh.length > MOST_CARDS) {
    // The oldest of those nobody has go first.
    const room = MOST_CARDS - fresh.length;
    const old = await tx
      .select({ agent: agentCards.agentId })
      .from(agentCards)
      .where(and(eq(agentCards.userId, place.userId), eq(agentCards.projectId, place.project)))
      .orderBy(asc(agentCards.updatedAt))
      .limit(Math.max(0, had.size - room));
    if (old.length > 0)
      await tx.delete(agentCards).where(
        and(
          eq(agentCards.userId, place.userId),
          eq(agentCards.projectId, place.project),
          inArray(
            agentCards.agentId,
            old.map((row) => row.agent),
          ),
        ),
      );
  }
  let changed = fresh.length > 0;
  for (const { id, card } of ours) {
    const was = had.get(id);
    if (isRecord(was) && (was.state !== card.state || was.name !== card.name)) changed = true;
    await tx
      .insert(agentCards)
      .values({
        userId: place.userId,
        projectId: place.project,
        agentId: id,
        windowId: window,
        card,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [agentCards.userId, agentCards.projectId, agentCards.agentId],
        set: { windowId: window, card, updatedAt: now },
      });
  }
  if (changed) await tell(tx, place.userId, place.project, { k: "cards" });
};

/**
 * A window goes: what it had goes to whoever waits; what it took goes back, but for what it read;
 * what it said of them stays (a page that went away, whose ones are away then) where it says so.
 */
export const leaveWindow = (
  db: Db,
  place: Place,
  window: string,
  how: { readonly read: readonly string[]; readonly keepCards: boolean },
  now: Date,
) =>
  inProject(db, place.userId, place.project, async (tx) => {
    const mine = await tx
      .select({ agent: agentHolds.agentId, holds: agentHolds.holds })
      .from(agentHolds)
      .where(
        and(
          eq(agentHolds.userId, place.userId),
          eq(agentHolds.projectId, place.project),
          eq(agentHolds.windowId, window),
        ),
      );
    // Gone first, so that it is none of those that wait; kept as gone a while, so that what it
    // sent before it went does not make it be there again (`beThere`).
    await tx
      .insert(agentWindows)
      .values({ userId: place.userId, projectId: place.project, windowId: window, liveUntil: LEFT })
      .onConflictDoUpdate({
        target: [agentWindows.userId, agentWindows.projectId, agentWindows.windowId],
        set: { liveUntil: LEFT },
      });
    await tx
      .delete(agentHolds)
      .where(
        and(
          eq(agentHolds.userId, place.userId),
          eq(agentHolds.projectId, place.project),
          eq(agentHolds.windowId, window),
          eq(agentHolds.holds, false),
        ),
      );
    for (const row of mine) if (row.holds) await letGo(tx, place, row.agent, window, now);
    const claimed = and(
      eq(agentMail.userId, place.userId),
      eq(agentMail.projectId, place.project),
      eq(agentMail.claimedBy, window),
    );
    if (how.read.length > 0)
      await tx.delete(agentMail).where(and(claimed, inArray(agentMail.mailId, [...how.read])));
    await tx.update(agentMail).set({ claimedBy: null, claimedAt: null, left: true }).where(claimed);
    if (!how.keepCards)
      await tx
        .delete(agentCards)
        .where(
          and(
            eq(agentCards.userId, place.userId),
            eq(agentCards.projectId, place.project),
            eq(agentCards.windowId, window),
          ),
        );
    await tell(tx, place.userId, place.project, { k: "cards" });
  });

/** Has one right away, where no window does. "busy" where the person has as many windows. */
export const holdNow = (db: Db, place: Place, window: string, agent: string, now: Date) =>
  inProject(db, place.userId, place.project, async (tx) => {
    const live = await beThere(tx, place, window, now);
    if (live === "busy" || live === "left") return live;
    const holder = await settle(tx, place, agent, await holdsOf(tx, place, [agent]), live, now);
    if (holder === window) return true;
    if (holder !== undefined) return false;
    const count = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentHolds)
      .where(
        and(
          eq(agentHolds.userId, place.userId),
          eq(agentHolds.projectId, place.project),
          eq(agentHolds.windowId, window),
        ),
      );
    if ((count[0]?.n ?? 0) >= MOST_SERVED) return false;
    await take(tx, place, agent, window, now);
    await tell(tx, place.userId, place.project, { k: "cards" });
    return true;
  });

/**
 * Lets go of one for the first window that waits for it, and waits for it after that one: whether
 * it still has it, as none waits.
 */
export const yieldHold = (db: Db, place: Place, window: string, agent: string, now: Date) =>
  inProject(db, place.userId, place.project, async (tx) => {
    const live = await liveWindows(tx, place, now);
    const rows = await holdsOf(tx, place, [agent]);
    const holder = rows.find((row) => row.holds);
    if (!holder || holder.window !== window) return false;
    const next = rows.find((row) => !row.holds && row.window !== window && live.has(row.window));
    if (!next) return true;
    await tx.delete(agentHolds).where(holdsWhere(place, agent, window));
    await give(tx, place, agent, next.window, now);
    await waitFor(tx, place, agent, window, now);
    return false;
  });

/** What the windows said of those they have or had within `AWAY_MS`, and which are had now. */
export const rosterOf = async (db: Db, place: Place, now: Date) => {
  const cards = await db
    .select({ id: agentCards.agentId, card: agentCards.card, at: agentCards.updatedAt })
    .from(agentCards)
    .where(
      and(
        eq(agentCards.userId, place.userId),
        eq(agentCards.projectId, place.project),
        gt(agentCards.updatedAt, new Date(now.getTime() - AWAY_MS)),
      ),
    )
    .limit(MOST_CARDS);
  const held = await db
    .select({ id: agentHolds.agentId })
    .from(agentHolds)
    .innerJoin(
      agentWindows,
      and(
        eq(agentWindows.userId, agentHolds.userId),
        eq(agentWindows.projectId, agentHolds.projectId),
        eq(agentWindows.windowId, agentHolds.windowId),
      ),
    )
    .where(
      and(
        eq(agentHolds.userId, place.userId),
        eq(agentHolds.projectId, place.project),
        eq(agentHolds.holds, true),
        gt(agentWindows.liveUntil, now),
      ),
    );
  const had = new Set(held.map((row) => row.id));
  return {
    agents: cards.map((row) => ({
      id: row.id,
      card: row.card,
      live: had.has(row.id),
      at: row.at.getTime(),
    })),
    held: [...had],
  };
};

export interface MailPost {
  readonly id: string;
  readonly to: string;
  readonly from: string;
  readonly text: string;
  readonly at: number;
  readonly left: boolean;
  readonly body: Record<string, unknown>;
  readonly most: number;
  readonly repeatMs: number;
}

export const mailPostOf = (body: unknown): MailPost | "tooLarge" | undefined => {
  if (!isRecord(body) || !isRecord(body.mail)) return undefined;
  const { mail, most, repeatMs } = body;
  const { id, to, from, text, at, left } = mail;
  if (!isAgent(id) || !isAgent(to) || !isAgent(from)) return undefined;
  if (typeof text !== "string" || typeof left !== "boolean") return undefined;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return undefined;
  if (!isRecord(mail.body)) return undefined;
  if (typeof most !== "number" || !Number.isInteger(most) || most < 1) return undefined;
  if (typeof repeatMs !== "number" || !Number.isInteger(repeatMs) || repeatMs < 0) return undefined;
  if (text.length > MESSAGE_CHARS || bytesOf(mail.body) > MAIL_BYTES) return "tooLarge";
  return {
    id,
    to,
    from,
    text,
    at,
    left,
    body: mail.body,
    most: Math.min(most, MOST_WAITING),
    repeatMs: Math.min(repeatMs, REPEAT_MS),
  };
};

/**
 * Leaves a message for one, and tells the window that has it: unless as many wait for it, or for the
 * project, or the same words from the same one came within the while. Left (for whoever opens it)
 * where no window has it now, whatever the sender thought. The same message again is posted once.
 */
export const postMail = (db: Db, place: Place, mail: MailPost, now: Date) =>
  inProject(db, place.userId, place.project, async (tx) => {
    const mine = and(eq(agentMail.userId, place.userId), eq(agentMail.projectId, place.project));
    const [again] = await tx
      .select({ id: agentMail.mailId })
      .from(agentMail)
      .where(and(mine, eq(agentMail.mailId, mail.id)));
    if (again) return "posted" as const;
    const waiting = await tx
      .select({ from: agentMail.fromAgent, text: agentMail.text, at: agentMail.createdAt })
      .from(agentMail)
      .where(and(mine, eq(agentMail.toAgent, mail.to), gt(agentMail.expiresAt, now)));
    if (
      waiting.some(
        (each) =>
          each.from === mail.from &&
          each.text === mail.text &&
          now.getTime() - each.at.getTime() < mail.repeatMs,
      )
    )
      return "repeat" as const;
    if (waiting.length >= mail.most) return "full" as const;
    const [all] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentMail)
      .where(and(mine, gt(agentMail.expiresAt, now)));
    if ((all?.n ?? 0) >= MOST_MAIL) return "full" as const;
    const live = await liveWindows(tx, place, now);
    const holder = (await holdsOf(tx, place, [mail.to])).find(
      (row) => row.holds && live.has(row.window),
    );
    await tx.insert(agentMail).values({
      userId: place.userId,
      projectId: place.project,
      mailId: mail.id,
      toAgent: mail.to,
      fromAgent: mail.from,
      text: mail.text,
      body: mail.body,
      left: mail.left || holder === undefined,
      sentAt: mail.at,
      createdAt: now,
      expiresAt: new Date(now.getTime() + MAIL_MS),
    });
    await tell(tx, place.userId, place.project, { k: "mail", to: mail.to });
    return "posted" as const;
  });

/**
 * Takes the messages for one the window has, and those a window that went took: the window's from
 * then on, until it says it is done with them or gives them back, or goes. None for one it does not
 * have.
 */
export const claimMail = (db: Db, place: Place, window: string, to: string, now: Date) =>
  inProject(db, place.userId, place.project, async (tx) => {
    const live = await liveWindows(tx, place, now);
    if (!live.has(window)) return [];
    const holder = (await holdsOf(tx, place, [to])).find((row) => row.holds);
    if (holder?.window !== window) return [];
    const mine = and(
      eq(agentMail.userId, place.userId),
      eq(agentMail.projectId, place.project),
      eq(agentMail.toAgent, to),
    );
    await tx.delete(agentMail).where(and(mine, lte(agentMail.expiresAt, now)));
    const taken = await tx
      .update(agentMail)
      .set({ claimedBy: window, claimedAt: now })
      .where(and(mine, free(place, window, live)))
      .returning();
    return taken
      .map((row) => ({
        id: row.mailId,
        to: row.toAgent,
        from: row.fromAgent,
        text: row.text,
        at: row.sentAt,
        left: row.left,
        body: row.body,
      }))
      .toSorted((a, b) => a.at - b.at);
  });

/** Messages the window took that it is done with: they go. */
export const doneMail = async (db: Db, place: Place, window: string, ids: readonly string[]) => {
  if (ids.length === 0) return;
  await db
    .delete(agentMail)
    .where(
      and(
        eq(agentMail.userId, place.userId),
        eq(agentMail.projectId, place.project),
        eq(agentMail.claimedBy, window),
        inArray(agentMail.mailId, [...ids]),
      ),
    );
};

/** Messages the window took and gives back: they wait for whoever opens the one they are for. */
export const backMail = async (db: Db, place: Place, window: string, ids: readonly string[]) => {
  if (ids.length === 0) return;
  await db
    .update(agentMail)
    .set({ claimedBy: null, claimedAt: null, left: true })
    .where(
      and(
        eq(agentMail.userId, place.userId),
        eq(agentMail.projectId, place.project),
        eq(agentMail.claimedBy, window),
        inArray(agentMail.mailId, [...ids]),
      ),
    );
};

/**
 * What one window tells the others, as it may: of a size, of an id, with the window it is of
 * (`w`), which does not hear it itself.
 */
export const signalOf = (body: unknown): AgentsSaid | undefined => {
  if (!isRecord(body) || typeof body.window !== "string" || !WINDOW_ID.test(body.window))
    return undefined;
  const w = body.window;
  if (body.kind === "want" && isAgent(body.id) && typeof body.take === "boolean")
    return { k: "want", w, id: body.id, take: body.take };
  if (body.kind === "gone" && isAgent(body.id)) return { k: "gone", w, id: body.id };
  if (body.kind === "answer" && isAgent(body.mail) && bytesOf(body.outcome) <= ANSWER_BYTES)
    return { k: "answer", w, mail: body.mail, outcome: body.outcome ?? null };
  return undefined;
};

export const signal = (db: Db, place: Place, said: AgentsSaid) =>
  tell(db, place.userId, place.project, said);

/** One asks to be told once another is next idle: the newest so many, within `WATCH_MS`. */
export const watch = (
  db: Db,
  place: Place,
  target: string,
  watcher: string,
  until: number,
  now: Date,
) =>
  inProject(db, place.userId, place.project, async (tx) => {
    const of = and(
      eq(agentWatches.userId, place.userId),
      eq(agentWatches.projectId, place.project),
      eq(agentWatches.target, target),
    );
    await tx
      .delete(agentWatches)
      .where(and(of, or(lte(agentWatches.until, now), eq(agentWatches.watcher, watcher))));
    const kept = await tx
      .select({ watcher: agentWatches.watcher })
      .from(agentWatches)
      .where(of)
      .orderBy(asc(agentWatches.until));
    const over = kept.length + 1 - MOST_WATCHERS;
    if (over > 0)
      await tx.delete(agentWatches).where(
        and(
          of,
          inArray(
            agentWatches.watcher,
            kept.slice(0, over).map((row) => row.watcher),
          ),
        ),
      );
    await tx.insert(agentWatches).values({
      userId: place.userId,
      projectId: place.project,
      target,
      watcher,
      until: new Date(Math.min(until, now.getTime() + WATCH_MS)),
    });
  });

/** Takes who asked to be told of one, and until when. */
export const takeWatchers = async (db: Db, place: Place, target: string, now: Date) => {
  const taken = await db
    .delete(agentWatches)
    .where(
      and(
        eq(agentWatches.userId, place.userId),
        eq(agentWatches.projectId, place.project),
        eq(agentWatches.target, target),
      ),
    )
    .returning({ watcher: agentWatches.watcher, until: agentWatches.until });
  return taken
    .filter((row) => row.until > now)
    .map((row) => ({ watcher: row.watcher, until: row.until.getTime() }));
};

/** One deleted for good: what was said of it, what waits for it, who waits on it or for it. */
export const forget = (db: Db, place: Place, agent: string) =>
  inProject(db, place.userId, place.project, async (tx) => {
    await tx
      .delete(agentCards)
      .where(
        and(
          eq(agentCards.userId, place.userId),
          eq(agentCards.projectId, place.project),
          eq(agentCards.agentId, agent),
        ),
      );
    await tx
      .delete(agentMail)
      .where(
        and(
          eq(agentMail.userId, place.userId),
          eq(agentMail.projectId, place.project),
          eq(agentMail.toAgent, agent),
        ),
      );
    await tx
      .delete(agentWatches)
      .where(
        and(
          eq(agentWatches.userId, place.userId),
          eq(agentWatches.projectId, place.project),
          or(eq(agentWatches.target, agent), eq(agentWatches.watcher, agent)),
        ),
      );
    await tell(tx, place.userId, place.project, { k: "cards" });
  });

/** Counts turns nobody was there for, or none as people said something: what it is then. */
export const countBudget = (
  db: Db,
  place: Place,
  change: { readonly add: number } | { readonly reset: true },
  now: Date,
  window?: string,
) =>
  inProject(db, place.userId, place.project, async (tx) => {
    const was = await budgetOf(tx, place, now);
    const count = "reset" in change ? 0 : Math.min(1_000_000, was.count + change.add);
    await tx
      .insert(agentBudgets)
      .values({ userId: place.userId, projectId: place.project, count, at: now })
      .onConflictDoUpdate({
        target: [agentBudgets.userId, agentBudgets.projectId],
        set: { count, at: now },
      });
    const said = { count, at: now.getTime() };
    await tell(tx, place.userId, place.project, { k: "budget", w: window, ...said });
    return said;
  });

/**
 * What lasts a while only, past its while: windows that went (and what they had with them),
 * messages of more than a week, who waited past their time, cards and counts of 12 hours ago.
 */
export const cleanUpAgents = async (db: Db, now: Date) => {
  const away = new Date(now.getTime() - AWAY_MS);
  const windows = await db
    .delete(agentWindows)
    .where(lt(agentWindows.liveUntil, new Date(now.getTime() - WINDOW_MS)))
    .returning({ id: agentWindows.windowId });
  const mail = await db
    .delete(agentMail)
    .where(lte(agentMail.expiresAt, now))
    .returning({ id: agentMail.mailId });
  const watches = await db
    .delete(agentWatches)
    .where(lte(agentWatches.until, now))
    .returning({ id: agentWatches.watcher });
  const cards = await db
    .delete(agentCards)
    .where(lt(agentCards.updatedAt, away))
    .returning({ id: agentCards.agentId });
  const budgets = await db
    .delete(agentBudgets)
    .where(lt(agentBudgets.at, away))
    .returning({ id: agentBudgets.projectId });
  return {
    windows: windows.length,
    mail: mail.length,
    watches: watches.length,
    cards: cards.length,
    budgets: budgets.length,
  };
};

/** The queue of pg-boss of the hourly round, see `cleanUpAgents`. */
export const AGENTS_CLEANUP_QUEUE = "agents-cleanup";

/** Runs the round every hour: one run an hour, however many APIs. What fails waits for the next. */
export const scheduleAgentsCleanup = async (boss: Jobs, db: Db, log: Logger) => {
  const queue = { retryLimit: 0, expireInSeconds: 30 * 60, deleteAfterSeconds: 24 * 3600 };
  await boss.createQueue(AGENTS_CLEANUP_QUEUE, { policy: "stately", ...queue });
  await boss.updateQueue(AGENTS_CLEANUP_QUEUE, queue);
  await boss.schedule(AGENTS_CLEANUP_QUEUE, "47 * * * *");
  await boss.work(AGENTS_CLEANUP_QUEUE, async () => {
    try {
      const done = await cleanUpAgents(db, new Date());
      if (Object.values(done).some((n) => n > 0))
        log.info({ ...done }, "messages of conversations tidied up");
    } catch (error) {
      log.warn({ err: describeError(error) }, "messages of conversations were not tidied up");
    }
  });
};

export interface AgentsRoutesOptions {
  readonly gate: AccessGate;
  readonly origin: string;
  readonly accounts: () => Accounts | undefined;
  readonly credentials: SessionCredentials;
  readonly db: () => Db | undefined;
  readonly now?: (() => number) | undefined;
}

type ProjectParams = { readonly project: string };
type WindowParams = ProjectParams & { readonly window: string };

export const agentsRoutes = async (app: FastifyInstance, options: AgentsRoutesOptions) => {
  const { db } = options;
  const now = options.now ?? Date.now;
  const guard = fromThisSite(options.origin);
  const signedIn = signedInWith(
    options.credentials,
    options.accounts,
    () => db() !== undefined,
    options.gate,
  );
  // A window says it is there every half minute, and more as what it has changes; a few windows.
  const limits = new Limits({ perClient: 6000, perOwn: 3000, ceiling: 60000 }, 10 * 60_000, now);
  const sends = new RateLimit(SENDS_PER_MINUTE, 60_000, now);
  const access = { access: { project: "project", action: "read" as const } };
  const base = "/api/me/projects/:project/agents";

  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: describeError(error) }, "failed");
      return reply.code(503).send({ error: "unavailable" });
    }
    if (status === 413) return reply.code(413).send({ error: "tooLarge" });
    return reply.code(status).send({ error: "invalid" });
  });

  /** Who asks, of which project and window; undefined where that was answered already. */
  const who = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await signedIn(request, reply, limits);
    const database = db();
    if (!user || !database) return undefined;
    const { project, window } = request.params as Partial<WindowParams>;
    if (window !== undefined && !WINDOW_ID.test(window)) {
      await reply.code(400).send({ error: "invalid" });
      return undefined;
    }
    reply.header("cache-control", "no-store");
    return {
      database,
      place: { userId: user.userId, project: project as string },
      window: window as string,
    };
  };
  const busy = (reply: FastifyReply, after = 30) =>
    reply.code(429).header("retry-after", String(after)).send({ error: "busy" });

  app.put<{ Params: WindowParams; Body: unknown }>(
    `${base}/windows/:window`,
    { config: access, preHandler: guard, bodyLimit: (MOST_SERVED + 1) * (CARD_BYTES + 512) },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const say = windowSayOf(request.body);
      if (say === "tooLarge") return reply.code(413).send({ error: "tooLarge" });
      if (!say) return reply.code(400).send({ error: "invalid" });
      const done = await sayWindow(asked.database, asked.place, asked.window, say, new Date(now()));
      if (done === "busy") return busy(reply);
      if (done === "left") return reply.code(409).send({ error: "left" });
      return done;
    },
  );

  app.post<{ Params: WindowParams; Body: unknown }>(
    `${base}/windows/:window/leave`,
    { config: access, preHandler: guard, bodyLimit: 64 * 1024 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const body = request.body ?? {};
      if (!isRecord(body)) return reply.code(400).send({ error: "invalid" });
      const read = body.read === undefined ? [] : idsOf(body.read);
      if (!read || (body.keepCards !== undefined && typeof body.keepCards !== "boolean"))
        return reply.code(400).send({ error: "invalid" });
      await leaveWindow(
        asked.database,
        asked.place,
        asked.window,
        { read, keepCards: body.keepCards === true },
        new Date(now()),
      );
      return reply.code(204).send();
    },
  );

  const agentOf = (body: unknown) =>
    isRecord(body) && isAgent(body.agent) ? body.agent : undefined;

  app.post<{ Params: WindowParams; Body: unknown }>(
    `${base}/windows/:window/hold`,
    { config: access, preHandler: guard, bodyLimit: 4096 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const agent = agentOf(request.body);
      if (!agent) return reply.code(400).send({ error: "invalid" });
      const owned = await holdNow(
        asked.database,
        asked.place,
        asked.window,
        agent,
        new Date(now()),
      );
      if (owned === "busy") return busy(reply);
      return { owned: owned === true };
    },
  );

  app.post<{ Params: WindowParams; Body: unknown }>(
    `${base}/windows/:window/yield`,
    { config: access, preHandler: guard, bodyLimit: 4096 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const agent = agentOf(request.body);
      if (!agent) return reply.code(400).send({ error: "invalid" });
      return {
        owned: await yieldHold(asked.database, asked.place, asked.window, agent, new Date(now())),
      };
    },
  );

  app.post<{ Params: WindowParams; Body: unknown }>(
    `${base}/windows/:window/claim`,
    { config: access, preHandler: guard, bodyLimit: 4096 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const agent = agentOf(request.body);
      if (!agent) return reply.code(400).send({ error: "invalid" });
      return {
        mail: await claimMail(asked.database, asked.place, asked.window, agent, new Date(now())),
      };
    },
  );

  for (const what of ["done", "back"] as const)
    app.post<{ Params: WindowParams; Body: unknown }>(
      `${base}/windows/:window/${what}`,
      { config: access, preHandler: guard, bodyLimit: 64 * 1024 },
      async (request, reply) => {
        const asked = await who(request, reply);
        if (!asked) return reply;
        const ids = isRecord(request.body) ? idsOf(request.body.ids) : undefined;
        if (!ids) return reply.code(400).send({ error: "invalid" });
        await (what === "done" ? doneMail : backMail)(
          asked.database,
          asked.place,
          asked.window,
          ids,
        );
        return reply.code(204).send();
      },
    );

  app.get<{ Params: ProjectParams }>(base, { config: access }, async (request, reply) => {
    const asked = await who(request, reply);
    if (!asked) return reply;
    return rosterOf(asked.database, asked.place, new Date(now()));
  });

  app.post<{ Params: ProjectParams; Body: unknown }>(
    `${base}/mail`,
    { config: access, preHandler: guard, bodyLimit: MAIL_BYTES + 8 * 1024 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const mail = mailPostOf(request.body);
      if (mail === "tooLarge") return reply.code(413).send({ error: "tooLarge" });
      if (!mail) return reply.code(400).send({ error: "invalid" });
      if (!sends.take(asked.place.userId)) return busy(reply, sends.retryAfter(asked.place.userId));
      return { result: await postMail(asked.database, asked.place, mail, new Date(now())) };
    },
  );

  app.post<{ Params: ProjectParams; Body: unknown }>(
    `${base}/signal`,
    { config: access, preHandler: guard, bodyLimit: 4096 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const said = signalOf(request.body);
      if (!said) return reply.code(400).send({ error: "invalid" });
      await signal(asked.database, asked.place, said);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: ProjectParams; Body: unknown }>(
    `${base}/watch`,
    { config: access, preHandler: guard, bodyLimit: 4096 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const body = request.body;
      if (
        !isRecord(body) ||
        !isAgent(body.target) ||
        !isAgent(body.watcher) ||
        typeof body.until !== "number" ||
        !Number.isFinite(body.until)
      )
        return reply.code(400).send({ error: "invalid" });
      await watch(
        asked.database,
        asked.place,
        body.target,
        body.watcher,
        body.until,
        new Date(now()),
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Params: ProjectParams; Body: unknown }>(
    `${base}/watchers`,
    { config: access, preHandler: guard, bodyLimit: 4096 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const body = request.body;
      if (!isRecord(body) || !isAgent(body.target))
        return reply.code(400).send({ error: "invalid" });
      return {
        watchers: await takeWatchers(asked.database, asked.place, body.target, new Date(now())),
      };
    },
  );

  app.post<{ Params: ProjectParams; Body: unknown }>(
    `${base}/forget`,
    { config: access, preHandler: guard, bodyLimit: 4096 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const agent = agentOf(request.body);
      if (!agent) return reply.code(400).send({ error: "invalid" });
      await forget(asked.database, asked.place, agent);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: ProjectParams; Body: unknown }>(
    `${base}/budget`,
    { config: access, preHandler: guard, bodyLimit: 1024 },
    async (request, reply) => {
      const asked = await who(request, reply);
      if (!asked) return reply;
      const body = request.body;
      const change =
        isRecord(body) && body.reset === true
          ? ({ reset: true } as const)
          : isRecord(body) &&
              typeof body.add === "number" &&
              Number.isInteger(body.add) &&
              body.add > 0 &&
              body.add <= 100
            ? { add: body.add }
            : undefined;
      const window = isRecord(body) ? body.window : undefined;
      if (
        !change ||
        (window !== undefined && (typeof window !== "string" || !WINDOW_ID.test(window)))
      )
        return reply.code(400).send({ error: "invalid" });
      return countBudget(asked.database, asked.place, change, new Date(now()), window);
    },
  );
};
