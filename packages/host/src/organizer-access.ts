import {
  CHANGE_TIMEOUT_MS,
  count,
  isObject,
  REQUEST_TIMEOUT_MS,
  text,
  withinTime,
} from "./answers.ts";
import {
  CloudOtherAccount,
  CloudSignedOut,
  ORGANIZER_BATCH,
  type AccountChanges,
  type AccountChangesAnswer,
  type AccountGroup,
  type AccountGroupOutcome,
  type AccountMarks,
  type AccountMarksOutcome,
  type AccountOrganized,
  type OrganizerAccess,
} from "./index.ts";

export interface BrowserOrganizerAccessOptions {
  /** The address of a path of the platform's API, such as `/organizer`. */
  readonly api: (path: string) => string;
  /** Headers the platform asks of requests that change something. */
  readonly changeHeaders?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  /** This computer's clock. */
  readonly now?: () => number;
  /** How long the platform has to answer, see `REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

/** The platform said it is busy: again after `retryAfterMs`. */
export class OrganizerBusy extends Error {
  override readonly name = "OrganizerBusy";
  constructor(readonly retryAfterMs: number) {
    super("The platform is busy");
  }
}

/** Times as the platform says them, as this computer's clock had them: `local = theirs - offset`. */
type Clock = (theirs: number) => number;

const groupOf = (value: unknown, clock: Clock): AccountGroup | undefined => {
  if (!isObject(value)) return undefined;
  const id = text(value.id);
  const name = text(value.name);
  const at = count(value.at);
  if (id === undefined || name === undefined || at === undefined) return undefined;
  return { id, name, at: clock(at), ...(value.deleted === true && { deleted: true }) };
};

const marksOf = (value: unknown, clock: Clock): AccountMarks | undefined => {
  if (!isObject(value)) return undefined;
  const project = text(value.project);
  if (project === undefined) return undefined;
  const star = isObject(value.star) ? value.star : undefined;
  const starAt = count(star?.at);
  const group = isObject(value.group) ? value.group : undefined;
  const groupAt = count(group?.at);
  const groupId = group?.id === null ? null : text(group?.id);
  return {
    project,
    ...(starAt !== undefined &&
      typeof star?.starred === "boolean" && { star: { starred: star.starred, at: clock(starAt) } }),
    ...(groupAt !== undefined &&
      groupId !== undefined && { group: { id: groupId, at: clock(groupAt) } }),
  };
};

const stateOf = (value: unknown, clock: Clock): AccountOrganized | undefined => {
  if (!isObject(value) || !Array.isArray(value.groups) || !Array.isArray(value.marks))
    return undefined;
  const account = text(value.account);
  if (account === undefined) return undefined;
  const groups = value.groups.map((each) => groupOf(each, clock));
  const marks = value.marks.map((each) => marksOf(each, clock));
  // Anything that cannot be read is not taken for nothing: the whole answer is not.
  if (groups.includes(undefined) || marks.includes(undefined)) return undefined;
  return { account, groups: groups as AccountGroup[], marks: marks as AccountMarks[] };
};

const groupOutcomeOf = (value: unknown): AccountGroupOutcome | undefined => {
  if (
    value === "kept" ||
    value === "older" ||
    value === "missing" ||
    value === "tooMany" ||
    value === "invalid"
  )
    return value;
  const taken = isObject(value) ? text(value.taken) : undefined;
  return taken === undefined ? undefined : { taken };
};

const FIELD = new Set(["kept", "older", "noGroup"]);

const marksOutcomeOf = (value: unknown): AccountMarksOutcome | undefined => {
  if (!isObject(value)) return undefined;
  const project = text(value.project);
  if (project === undefined) return undefined;
  const star = value.star === "kept" || value.star === "older" ? value.star : undefined;
  const group = typeof value.group === "string" && FIELD.has(value.group) ? value.group : undefined;
  return {
    project,
    ...(value.missing === true && { missing: true }),
    ...(star !== undefined && { star }),
    ...(group !== undefined && { group: group as NonNullable<AccountMarksOutcome["group"]> }),
  };
};

/**
 * How the person organises their projects on a platform, over its HTTP API, see `OrganizerAccess`:
 *
 * - `GET <api>/organizer` answers `{now, account, groups, marks}`: `AccountOrganized` by the
 *   platform's clock, and what that said then (`now`).
 * - `POST <api>/organizer` with `{now, account, groups?, marks?}`, `AccountChanges` by this
 *   computer's clock and what that says as it sends them: the platform has them agree with its own.
 *   It answers `{now, groups, marks, state}`, see `AccountChangesAnswer`; 409 "otherAccount" where
 *   its session is of somebody else than `account`, and nothing is kept.
 *
 * Both say 401 "signedOut", 429 "busy" with Retry-After. Times come back by this computer's clock:
 * the difference between the two clocks is taken as what it was as the request went and came back.
 */
export function browserOrganizerAccess(options: BrowserOrganizerAccessOptions): OrganizerAccess {
  const request = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const path = options.api("/organizer");
  const ask = async (init: RequestInit, signal: AbortSignal) => {
    const sent = now();
    const response = await request(path, { cache: "no-store", ...init, signal });
    const came = now();
    const answer: unknown = await response.json().catch(() => undefined);
    const said = isObject(answer) ? answer.error : undefined;
    if (response.status === 401 || said === "signedOut")
      throw new CloudSignedOut("Nobody is signed in");
    if (response.status === 409 && said === "otherAccount")
      throw new CloudOtherAccount("Somebody else is signed in");
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      throw new OrganizerBusy(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000);
    }
    if (!response.ok || !isObject(answer))
      throw new Error(`The platform answered ${response.status}`);
    const theirs = count(answer.now);
    if (theirs === undefined) throw new Error("The platform did not say what time it is");
    const offset = theirs - (sent + came) / 2;
    const clock: Clock = (at) => Math.round(at - offset);
    return { answer, clock };
  };
  return {
    read: () =>
      withinTime(options.timeoutMs ?? REQUEST_TIMEOUT_MS, async (signal) => {
        const { answer, clock } = await ask({}, signal);
        const state = stateOf(answer, clock);
        if (!state) throw new Error("The platform answered something that cannot be read");
        return state;
      }),
    change: (changes: AccountChanges) =>
      withinTime(options.timeoutMs ?? CHANGE_TIMEOUT_MS, async (signal) => {
        const groups = changes.groups ?? [];
        const marks = changes.marks ?? [];
        if (groups.length > ORGANIZER_BATCH || marks.length > ORGANIZER_BATCH)
          throw new RangeError("Too many changes in one go");
        const { answer, clock } = await ask(
          {
            method: "POST",
            headers: { ...options.changeHeaders, "content-type": "application/json" },
            body: JSON.stringify({ now: now(), account: changes.account, groups, marks }),
          },
          signal,
        );
        const state = stateOf(answer.state, clock);
        const groupOutcomes = Array.isArray(answer.groups) ? answer.groups.map(groupOutcomeOf) : [];
        const marksOutcomes = Array.isArray(answer.marks) ? answer.marks.map(marksOutcomeOf) : [];
        if (
          !state ||
          groupOutcomes.length !== groups.length ||
          marksOutcomes.length !== marks.length ||
          groupOutcomes.includes(undefined) ||
          marksOutcomes.includes(undefined)
        )
          throw new Error("The platform answered something that cannot be read");
        return {
          groups: groupOutcomes as AccountGroupOutcome[],
          marks: marksOutcomes as AccountMarksOutcome[],
          state,
        } satisfies AccountChangesAnswer;
      }),
  };
}
