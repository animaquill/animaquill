import {
  CloudOtherAccount,
  CloudSignedOut,
  ORGANIZER_BATCH,
  unsentOf,
  type AccountGroup,
  type AccountOrganized,
  type OrganizerAccess,
  type ProjectGroup,
  type ProjectMarksChange,
  type ProjectOrganizer,
} from "@animaquill/host";
import { cloudMarksKey } from "./cards.ts";

/**
 * How the stars and groups of projects of the platform, and the groups, go with the account, see
 * the design of the start page (docs/design/start-and-cloud.md of AnimaQuill Cloud), 6.6: this
 * browser keeps a copy (`Host.organizer`), which the start page shows and changes at once; the
 * account (`CloudAccess.organizer`) is given what changed here and read for what changed elsewhere.
 * Nothing is ever taken whole: each field (the star, the group of a project; a group as a whole)
 * goes by when it last changed, the later wins, and what changed here later than what the account
 * has stays, to be given to it next time. What went wrong is tried again later, without a word.
 *
 * Rules, each with a test in organize-sync.test.ts:
 *
 * - Both changed the same field: the later change wins, the other field is not touched.
 * - A group taken away on one side, a project put into it on the other: the group is taken away,
 *   the project says it is in it and shows in none, as a group renamed later brings it back.
 * - A group of this browser, or made offline, of the name of a group of the account: they are one,
 *   the account's, and projects in the one move into it. A group the account has, renamed here
 *   into the name of another one: the rename does not count, the group keeps the name it has there.
 * - A project of the platform that is gone: its marks here are forgotten.
 * - Clocks that do not agree: the host has the platform's times by this computer's clock, see
 *   `OrganizerAccess`, and the platform takes none later than its own now. Times kept here that are
 *   still to come, as this computer's clock was ahead once, become now; what people do here comes
 *   after whatever is kept here.
 * - The platform's session is of somebody else than this window took to be signed in, as another
 *   window signed out and in again: nothing is given or taken, and who is signed in is asked again.
 * - A name that no group can have, as one with a tab pasted from a table: given as it is kept
 *   (`cleanGroupName`), which the copy here takes; one that is nothing then stays here.
 */

/** Keeps a copy of everything the account has, as the account's, and what it has of each. */
async function adopt(
  local: ProjectOrganizer,
  account: string,
  state: AccountOrganized,
): Promise<void> {
  if (state.account !== account)
    throw new CloudOtherAccount("The platform's session is of somebody else");
  await local.adoptGroups(state.groups.map((group) => copyOf(group, account)));
  await local.markAll(
    state.marks.map((each): readonly [string, ProjectMarksChange] => {
      const { star, group } = each;
      return [
        cloudMarksKey(each.project),
        {
          at: Math.max(star?.at ?? -Infinity, group?.at ?? -Infinity, 0),
          account,
          ...(star && { starredAt: star.starred ? star.at : null, starAt: star.at }),
          ...(group && { group: group.id, groupAt: group.at }),
          sent: { ...(star && { star: star.at }), ...(group && { group: group.at }) },
        },
      ];
    }),
  );
}

/** A group as the account has it, as this browser keeps it: the account has it as it is. */
const copyOf = (group: AccountGroup, account: string): ProjectGroup => ({
  id: group.id,
  name: group.name,
  scope: { account },
  at: group.at,
  ...(group.deleted && { deleted: true }),
  sent: group.at,
});

/**
 * Gives the account what changed here since it heard (`unsentOf`), in batches, and keeps what came
 * of it. Resolves to whether anything was settled: what the account does not take stays as it is,
 * to be given again next time.
 */
async function push(
  local: ProjectOrganizer,
  remote: OrganizerAccess,
  account: string,
): Promise<boolean> {
  const content = await local.read();
  const { groups, marks } = unsentOf(content, account);
  let settled = false;
  for (let from = 0; from < Math.max(groups.length, marks.length); from += ORGANIZER_BATCH) {
    const someGroups = groups.slice(from, from + ORGANIZER_BATCH);
    const someMarks = marks.slice(from, from + ORGANIZER_BATCH);
    const answer = await remote.change({ account, groups: someGroups, marks: someMarks });
    if (answer.state.account !== account)
      throw new CloudOtherAccount("The platform's session is of somebody else");
    const given: ProjectGroup[] = [];
    const became: [from: string, into: string][] = [];
    const renamed: ProjectGroup[] = [];
    someGroups.forEach((group, index) => {
      const outcome = answer.groups[index];
      if (outcome === "kept" || outcome === "missing") given.push(copyOf(group, account));
      else if (typeof outcome === "object") {
        // One the account has, renamed here into the name of another: the rename is let go of, as
        // the account has it. One it never had is the one of that name.
        const there = answer.state.groups.find(({ id }) => id === group.id);
        if (there) renamed.push(copyOf(there, account));
        else became.push([group.id, outcome.taken]);
      }
      // "older": what the account has comes with the state. "tooMany", "invalid": it stays here.
      if (outcome !== "tooMany" && outcome !== "invalid") settled = true;
    });
    const sent: [string, ProjectMarksChange][] = [];
    const gone: string[] = [];
    someMarks.forEach((one, index) => {
      const outcome = answer.marks[index];
      const key = cloudMarksKey(one.project);
      if (outcome?.missing) {
        settled = true;
        const kept = content.marks.get(key);
        // Its own project that is not there any more is gone; what is of no account here may be
        // of another one, which says so: it is not given again.
        if (kept?.account === account) gone.push(key);
        else
          sent.push([
            key,
            {
              at: kept?.at ?? 0,
              sent: {
                ...(one.star && { star: one.star.at }),
                ...(one.group && { group: one.group.at }),
              },
            },
          ]);
        return;
      }
      const star = outcome?.star === "kept" && one.star ? one.star.at : undefined;
      const group = outcome?.group === "kept" && one.group ? one.group.at : undefined;
      if (
        outcome?.star !== undefined ||
        (outcome?.group !== undefined && outcome.group !== "noGroup")
      )
        settled = true;
      if (star !== undefined || group !== undefined)
        sent.push([
          key,
          {
            at: content.marks.get(key)?.at ?? 0,
            sent: { ...(star !== undefined && { star }), ...(group !== undefined && { group }) },
          },
        ]);
    });
    // What it took counts as given, unless it changed here meanwhile; then what it has, which
    // takes the place of nothing that changed here later; then groups that it had by that name.
    await local.adoptGroups(given);
    if (sent.length > 0) await local.markAll(sent);
    await adopt(local, account, answer.state);
    if (renamed.length > 0) await local.adoptGroups(renamed, { replace: true });
    for (const [one, other] of became) await local.mergeGroup(one, other);
    for (const key of gone) await local.forget(key);
  }
  return settled;
}

/**
 * Has times of `account` kept here that are still to come become `now`, values as they are: a
 * clock that was ahead left them, and nothing that changed elsewhere since would come after them.
 */
async function notAhead(local: ProjectOrganizer, account: string, now: number): Promise<void> {
  const content = await local.read();
  const ahead = (at: number | undefined) => at !== undefined && at > now;
  const groups = content.groups.filter(
    (group) =>
      group.scope !== "browser" &&
      group.scope.account === account &&
      (ahead(group.at) || ahead(group.sent)),
  );
  if (groups.length > 0)
    await local.adoptGroups(
      groups.map((group) => ({
        ...group,
        at: Math.min(group.at, now),
        ...(group.sent !== undefined && { sent: Math.min(group.sent, now) }),
      })),
      { replace: true },
    );
  const marks = [...content.marks].filter(
    ([key, each]) =>
      key.startsWith("cloud:") &&
      (each.account === undefined || each.account === account) &&
      [each.at, each.starAt, each.groupAt, each.sent?.star, each.sent?.group].some(ahead),
  );
  if (marks.length > 0)
    await local.markAll(marks.map(([key, each]) => [key, { at: each.at, notAfter: now }]));
}

/**
 * One round with the account: reads it, has the groups of this browser become its own, and gives it
 * what changed here. Rejects where the platform could not say: nothing is lost, the next round goes
 * on from what is kept here.
 */
export async function syncOrganizer(
  local: ProjectOrganizer,
  remote: OrganizerAccess,
  account: string,
  now: () => number = Date.now,
): Promise<void> {
  const state = await remote.read();
  if (state.account !== account)
    throw new CloudOtherAccount("The platform's session is of somebody else");
  await local.noteAccount(account);
  await notAhead(local, account, now());
  await adopt(local, account, state);
  await local.claimGroups(account);
  // A group that became another moves projects into that one, which is given again.
  for (let round = 0; round < 3; round += 1) if (!(await push(local, remote, account))) break;
}

export interface OrganizerSyncOptions {
  readonly local: ProjectOrganizer;
  readonly remote: OrganizerAccess;
  /** Who is signed in, by `AccountSnapshot.id`: undefined while nobody is, or that is not known. */
  readonly account: () => string | undefined;
  /** Only tests: a timer of their own. */
  readonly setTimer?: (run: () => void, ms: number) => () => void;
  /**
   * The platform's session is of somebody else than `account` says, see `CloudOtherAccount`: who
   * is signed in is to be asked again. Nothing goes until then.
   */
  readonly otherAccount?: () => void;
}

/** How long after a change it is given to the account: changes in a row go in one. */
const SOON_MS = 800;
/** How long a round that failed waits before the next, at first, and at most. */
const RETRY_MS = 5000;
const RETRY_MOST_MS = 120_000;

const defaultTimer = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * When to go a round with the account, see `syncOrganizer`: soon after something changed here, or
 * somebody signed in, or the start page was opened; one round at a time; after one that failed,
 * again a while later, longer each time, as people are not told.
 */
export class OrganizerSync {
  readonly #options: OrganizerSyncOptions;
  readonly #setTimer: (run: () => void, ms: number) => () => void;
  #cancel: (() => void) | undefined;
  #due = Infinity;
  #running: Promise<void> | undefined;
  #again = false;
  #failures = 0;
  #closed = false;

  constructor(options: OrganizerSyncOptions) {
    this.#options = options;
    this.#setTimer = options.setTimer ?? defaultTimer;
  }

  /** Goes a round in `ms`, or sooner where one is due sooner. */
  soon(ms = SOON_MS): void {
    if (this.#closed) return;
    const due = Date.now() + ms;
    if (this.#cancel && due >= this.#due) return;
    this.#cancel?.();
    this.#due = due;
    this.#cancel = this.#setTimer(() => {
      this.#cancel = undefined;
      this.#due = Infinity;
      void this.run();
    }, ms);
  }

  /** Goes a round now, or after the one that goes; resolves once it is over. Never rejects. */
  async run(): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    const account = this.#options.account();
    if (account === undefined || this.#closed) return;
    this.#running = (async () => {
      try {
        await syncOrganizer(this.#options.local, this.#options.remote, account);
        this.#failures = 0;
      } catch (error) {
        // Somebody signing in again goes on from here.
        if (error instanceof CloudSignedOut) return;
        if (error instanceof CloudOtherAccount) {
          this.#options.otherAccount?.();
          return;
        }
        this.#failures += 1;
        const busy = (error as { retryAfterMs?: unknown }).retryAfterMs;
        const wait =
          typeof busy === "number"
            ? busy
            : Math.min(RETRY_MOST_MS, RETRY_MS * 2 ** (this.#failures - 1));
        console.warn("How projects are organised goes to the account later", error);
        this.soon(wait);
      }
    })();
    try {
      await this.#running;
    } finally {
      this.#running = undefined;
    }
    if (this.#again) {
      this.#again = false;
      this.soon(0);
    }
  }

  close(): void {
    this.#closed = true;
    this.#cancel?.();
    this.#cancel = undefined;
  }
}
