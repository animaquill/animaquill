import { OWNER_ONLY, type AccessPolicy } from "../access.ts";
import { groupNameKey, groupNameOf, ORGANIZER_BATCH } from "@animaquill/host/organizer";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { retryOnDeadlock, type Db, type Tx } from "../database.ts";
import { projectGroups, projectMarks, projects, users } from "../schema.ts";

/**
 * How people organise their projects of the platform on the start page, for the start page on any
 * computer: their groups (`project_groups`), and which of their projects are starred, in which
 * group each is and when it was last opened (`project_marks`). The editor of the online mode reads
 * them from here and writes each change here at once, see `OrganizerAccess` of the editor's host:
 * two computers show the same as soon as each looks again. Only ever of the person who is signed
 * in, and only of their own projects.
 *
 * Nothing is taken whole. Each field goes by when it last changed, as the editor says (`at`), and
 * a change is kept where it is as late as what is there, or later:
 *
 * - the star of a project and its group, each on its own: one computer starring a project and
 *   another moving it keeps both; when it was last opened, the latest of what any computer said;
 * - a group as a whole: made, renamed, taken away. One that is taken away stays, as such, so that a
 *   computer that renamed it later brings it back, and one that renamed it before does not. A tie
 *   goes to taking it away.
 * - What says it is in a group that is taken away stays so: it is in none, until the group comes
 *   back. A group that is not there at all is none to be in ("noGroup").
 * - Two groups that are there do not have one name, whatever the case or width of their letters:
 *   the second is told which one has it (`taken`), and the editor makes its own that one.
 *
 * Clocks of computers do not agree. Each request says what the editor's clock says as it sends it
 * (`now`), and its times are taken as that much off the platform's; none is later than the
 * platform's own now. What the platform answers is by its own clock, with its `now`, see
 * `browserOrganizerAccess` of the host.
 */

/** How many groups a person may have, that are there. */
export const GROUPS_PER_USER = 200;
/** How many that were taken away are kept at most: the oldest go first, once a new one is made. */
export const DELETED_GROUPS_KEPT = 500;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The latest time a request may say, in milliseconds since 1970: in the year 2286. */
const LATEST = 10_000_000_000_000;

export interface GroupChange {
  readonly id: string;
  /** Trimmed. Missing for one taken away. */
  readonly name?: string;
  readonly deleted?: true;
  readonly at: number;
  /** Its name is none a group can have, see `groupNameOf`: it is answered "invalid", nothing kept. */
  readonly invalid?: true;
}

export interface MarksChange {
  readonly project: string;
  readonly star?: { readonly starred: boolean; readonly at: number };
  readonly group?: { readonly id: string | null; readonly at: number };
  /** It was opened then: the latest of these is kept, whichever computer said it. */
  readonly opened?: { readonly at: number };
}

export interface OrganizerChanges {
  /** Whose the editor took them to be: none are kept where that is not who is signed in. */
  readonly account: string;
  /** What the editor's clock said as it sent them. */
  readonly now?: number;
  readonly groups: readonly GroupChange[];
  readonly marks: readonly MarksChange[];
}

export type GroupOutcome =
  "kept" | "older" | "missing" | "tooMany" | "invalid" | { readonly taken: string };

export interface MarksOutcome {
  readonly project: string;
  readonly missing?: true;
  readonly star?: "kept" | "older";
  readonly group?: "kept" | "older" | "noGroup";
  readonly opened?: "kept" | "older";
}

/** Everything a person keeps of how their projects are organised, by the platform's clock. */
export interface Organized {
  /** Whose it is: the person's id, see `users.id`. */
  readonly account: string;
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly at: number;
    readonly deleted?: true;
  }[];
  readonly marks: readonly {
    readonly project: string;
    readonly star?: { readonly starred: boolean; readonly at: number };
    readonly group?: { readonly id: string | null; readonly at: number };
    readonly opened?: number;
  }[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= LATEST;

export { groupNameOf };

const groupChangeOf = (value: unknown): GroupChange | undefined => {
  if (!isObject(value) || typeof value.id !== "string" || !ID.test(value.id) || !isTime(value.at))
    return undefined;
  if (value.deleted === true) return { id: value.id, deleted: true, at: value.at };
  if (value.deleted !== undefined || typeof value.name !== "string") return undefined;
  // A name no group can have is answered on its own: the rest of the request goes on.
  const name = groupNameOf(value.name);
  return name === undefined
    ? { id: value.id, at: value.at, invalid: true }
    : { id: value.id, name, at: value.at };
};

const marksChangeOf = (value: unknown): MarksChange | undefined => {
  if (!isObject(value) || typeof value.project !== "string" || !ID.test(value.project))
    return undefined;
  const { star, group, opened } = value;
  if (
    star !== undefined &&
    !(isObject(star) && typeof star.starred === "boolean" && isTime(star.at))
  )
    return undefined;
  if (
    group !== undefined &&
    !(
      isObject(group) &&
      (group.id === null || (typeof group.id === "string" && ID.test(group.id))) &&
      isTime(group.at)
    )
  )
    return undefined;
  if (opened !== undefined && !(isObject(opened) && isTime(opened.at))) return undefined;
  if (star === undefined && group === undefined && opened === undefined) return undefined;
  return {
    project: value.project,
    ...(isObject(star) && {
      star: { starred: star.starred as boolean, at: star.at as number },
    }),
    ...(isObject(group) && {
      group: { id: group.id as string | null, at: group.at as number },
    }),
    ...(isObject(opened) && { opened: { at: opened.at as number } }),
  };
};

/** What a request gives, or undefined where any of it is not what it should be. */
export const changesOf = (body: unknown): OrganizerChanges | undefined => {
  if (!isObject(body)) return undefined;
  const groups = body.groups ?? [];
  const marks = body.marks ?? [];
  if (!Array.isArray(groups) || !Array.isArray(marks)) return undefined;
  if (groups.length > ORGANIZER_BATCH || marks.length > ORGANIZER_BATCH) return undefined;
  if (body.now !== undefined && !isTime(body.now)) return undefined;
  if (typeof body.account !== "string" || body.account === "") return undefined;
  const readGroups = groups.map(groupChangeOf);
  const readMarks = marks.map(marksChangeOf);
  if (readGroups.includes(undefined) || readMarks.includes(undefined)) return undefined;
  return {
    account: body.account,
    ...(typeof body.now === "number" && { now: body.now }),
    groups: readGroups as GroupChange[],
    marks: readMarks as MarksChange[],
  };
};

/**
 * A time the editor said, by the platform's clock: as much off as its clock was as it sent the
 * request (`said`), and never later than the platform's now.
 */
export const timeOf = (at: number, said: number | undefined, now: number): Date => {
  const skew = said === undefined ? 0 : now - said;
  return new Date(Math.min(now, Math.max(0, Math.round(at + skew))));
};

/** Everything `userId` keeps of how their projects are organised. */
export const readOrganized = async (
  db: Db | Tx,
  userId: string,
  access: AccessPolicy = OWNER_ONLY,
): Promise<Organized> => {
  const groups = await db
    .select({
      id: projectGroups.id,
      name: projectGroups.name,
      at: projectGroups.at,
      deleted: projectGroups.deleted,
    })
    .from(projectGroups)
    .where(eq(projectGroups.ownerId, userId))
    .orderBy(asc(projectGroups.createdAt), asc(projectGroups.id));
  // Of projects they may read only: what they have of one they may not any more is not theirs to
  // see.
  const marks = await db
    .select({
      project: projectMarks.projectId,
      starred: projectMarks.starred,
      starAt: projectMarks.starAt,
      groupId: projectMarks.groupId,
      groupAt: projectMarks.groupAt,
      openedAt: projectMarks.openedAt,
    })
    .from(projectMarks)
    .innerJoin(projects, eq(projects.id, projectMarks.projectId))
    .where(and(eq(projectMarks.userId, userId), access.visible(userId)))
    .orderBy(asc(projectMarks.projectId));
  return {
    account: userId,
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      at: group.at.getTime(),
      ...(group.deleted && { deleted: true as const }),
    })),
    marks: marks.map((row) => ({
      project: row.project,
      ...(row.starred !== null &&
        row.starAt !== null && {
          star: { starred: row.starred, at: row.starAt.getTime() },
        }),
      ...(row.groupAt !== null && {
        group: { id: row.groupId, at: row.groupAt.getTime() },
      }),
      ...(row.openedAt !== null && { opened: row.openedAt.getTime() }),
    })),
  };
};

type GroupRow = typeof projectGroups.$inferSelect;

/** Whether a change at `at` takes the place of what is there: as late or later; a tie goes to taking away. */
const isLater = (row: GroupRow, at: Date, deleted: boolean) =>
  at.getTime() > row.at.getTime() ||
  (at.getTime() === row.at.getTime() && (deleted || !row.deleted));

const applyGroup = async (
  tx: Tx,
  userId: string,
  change: GroupChange,
  at: Date,
): Promise<GroupOutcome> => {
  if (change.invalid) return "invalid";
  const [row] = await tx
    .select()
    .from(projectGroups)
    .where(and(eq(projectGroups.ownerId, userId), eq(projectGroups.id, change.id)));
  if (change.deleted) {
    if (!row) return "missing";
    if (!isLater(row, at, true)) return "older";
    await tx
      .update(projectGroups)
      .set({ deleted: true, at })
      .where(and(eq(projectGroups.ownerId, userId), eq(projectGroups.id, change.id)));
    return "kept";
  }
  const name = change.name!;
  if (row && !isLater(row, at, false)) return "older";
  const nameKey = groupNameKey(name);
  const [other] = await tx
    .select({ id: projectGroups.id })
    .from(projectGroups)
    .where(
      and(
        eq(projectGroups.ownerId, userId),
        eq(projectGroups.nameKey, nameKey),
        eq(projectGroups.deleted, false),
        sql`${projectGroups.id} <> ${change.id}`,
      ),
    );
  if (other) return { taken: other.id };
  if (!row || row.deleted) {
    const [{ live } = { live: 0 }] = await tx
      .select({ live: sql<number>`count(*)::int` })
      .from(projectGroups)
      .where(and(eq(projectGroups.ownerId, userId), eq(projectGroups.deleted, false)));
    if (live >= GROUPS_PER_USER) return "tooMany";
  }
  if (!row) {
    await tx.insert(projectGroups).values({ ownerId: userId, id: change.id, name, nameKey, at });
    await forgetOldDeleted(tx, userId);
  } else
    await tx
      .update(projectGroups)
      .set({ name, nameKey, deleted: false, at })
      .where(and(eq(projectGroups.ownerId, userId), eq(projectGroups.id, change.id)));
  return "kept";
};

/**
 * Lets go of the oldest of the groups taken away beyond `DELETED_GROUPS_KEPT`: projects that say
 * they are in one are in none from then on, as they were.
 */
const forgetOldDeleted = async (tx: Tx, userId: string) => {
  const old = await tx
    .select({ id: projectGroups.id })
    .from(projectGroups)
    .where(and(eq(projectGroups.ownerId, userId), eq(projectGroups.deleted, true)))
    .orderBy(sql`${projectGroups.at} desc`, asc(projectGroups.id))
    .offset(DELETED_GROUPS_KEPT);
  if (old.length === 0) return;
  const ids = old.map(({ id }) => id);
  await tx
    .update(projectMarks)
    .set({ groupId: null })
    .where(and(eq(projectMarks.userId, userId), inArray(projectMarks.groupId, ids)));
  await tx
    .delete(projectGroups)
    .where(and(eq(projectGroups.ownerId, userId), inArray(projectGroups.id, ids)));
};

const applyMarks = async (
  tx: Tx,
  userId: string,
  access: AccessPolicy,
  change: MarksChange,
  time: (at: number) => Date,
  now: Date,
): Promise<MarksOutcome> => {
  // Only of a project that is there and that they may read, which waits for one that is being taken
  // away: it is gone then, with what it had of this.
  const [project] = await tx
    .select({ id: projects.id, ownerId: projects.ownerId })
    .from(projects)
    .where(eq(projects.id, change.project))
    .for("key share");
  if (!project || !(await access.may(tx, userId, project, "read")))
    return { project: change.project, missing: true };
  const [row] = await tx
    .select()
    .from(projectMarks)
    .where(and(eq(projectMarks.userId, userId), eq(projectMarks.projectId, change.project)))
    .for("update");
  const set: Partial<typeof projectMarks.$inferInsert> = {};
  let star: MarksOutcome["star"];
  let group: MarksOutcome["group"];
  let opened: MarksOutcome["opened"];
  if (change.opened) {
    const at = time(change.opened.at);
    opened = !row?.openedAt || at.getTime() > row.openedAt.getTime() ? "kept" : "older";
    if (opened === "kept") set.openedAt = at;
  }
  if (change.star) {
    const at = time(change.star.at);
    star = !row?.starAt || at.getTime() >= row.starAt.getTime() ? "kept" : "older";
    if (star === "kept") Object.assign(set, { starred: change.star.starred, starAt: at });
  }
  if (change.group) {
    const at = time(change.group.at);
    const { id } = change.group;
    const [known] =
      id === null
        ? [{ id }]
        : await tx
            .select({ id: projectGroups.id })
            .from(projectGroups)
            .where(and(eq(projectGroups.ownerId, userId), eq(projectGroups.id, id)))
            .for("key share");
    if (!known) group = "noGroup";
    else {
      group = !row?.groupAt || at.getTime() >= row.groupAt.getTime() ? "kept" : "older";
      if (group === "kept") Object.assign(set, { groupId: id, groupAt: at });
    }
  }
  if (Object.keys(set).length > 0) {
    if (row)
      await tx
        .update(projectMarks)
        .set({ ...set, updatedAt: now })
        .where(and(eq(projectMarks.userId, userId), eq(projectMarks.projectId, change.project)));
    else
      await tx
        .insert(projectMarks)
        .values({ userId, projectId: change.project, ...set, updatedAt: now });
  }
  return {
    project: change.project,
    ...(star !== undefined && { star }),
    ...(group !== undefined && { group }),
    ...(opened !== undefined && { opened }),
  };
};

/**
 * Keeps what `userId` changed, the groups first, then the marks, each as the rules above say, in
 * one transaction; and answers what came of each, with everything as it is then. One request of a
 * person at a time: another one waits.
 */
export const applyOrganizer = (
  db: Db,
  userId: string,
  changes: OrganizerChanges,
  now: number,
  access: AccessPolicy = OWNER_ONLY,
): Promise<{
  readonly groups: readonly GroupOutcome[];
  readonly marks: readonly MarksOutcome[];
  readonly state: Organized;
}> =>
  retryOnDeadlock(() =>
    db.transaction(async (tx) => {
      // Not a lock on the person as such: what refers to them takes it meanwhile, as a session.
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for("no key update");
      const time = (at: number) => timeOf(at, changes.now, now);
      const groups: GroupOutcome[] = [];
      for (const change of changes.groups)
        groups.push(await applyGroup(tx, userId, change, time(change.at)));
      const marks: MarksOutcome[] = [];
      for (const change of changes.marks)
        marks.push(await applyMarks(tx, userId, access, change, time, new Date(now)));
      return { groups, marks, state: await readOrganized(tx, userId, access) };
    }),
  );
