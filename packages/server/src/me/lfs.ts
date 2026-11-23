import { OWNER_ONLY, type AccessPolicy } from "../access.ts";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../database.ts";
import { lfsObjects, projectRepos, projects, userPrefs } from "../schema.ts";
import { lockPrefs } from "./cloud.ts";

/**
 * What a person has in the large file storage (Git LFS) of the repositories of their projects, as
 * the platform put it there or found it there (`lfs_objects`), and how they go about it: whether
 * they said they know what it means, once for their account, and which of their projects put new
 * assets there by themselves.
 *
 * Only what the platform knows: GitHub keeps the room and the traffic of the account, and the
 * editor links there for that. A repository has one project of the platform at most.
 */

export interface LfsRepositoryUse {
  /** The repository, by its number on GitHub, and its names as last seen. */
  readonly repo: number;
  readonly fullName: string;
  readonly url: string;
  readonly project: { readonly id: string; readonly name: string };
  readonly files: number;
  readonly bytes: number;
}

export interface LfsAccount {
  /** When people said they know what it means, the first time; undefined: never. */
  readonly acknowledgedAt?: number;
  /** By repository, the largest first. */
  readonly repositories: readonly LfsRepositoryUse[];
}

export interface LfsChanges {
  readonly account: string;
  readonly acknowledged?: true;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What a request asks to change, or undefined where anything of it is not as it should be. */
export const lfsChangesOf = (body: unknown): LfsChanges | undefined => {
  if (!isObject(body)) return undefined;
  const { account, acknowledged } = body;
  if (typeof account !== "string" || account === "") return undefined;
  // `auto`: the switch of before, which pages of 0.3.119 still send until they reload. Where new
  // assets go is the project's now: it changes nothing.
  for (const name of Object.keys(body))
    if (!["account", "acknowledged", "auto"].includes(name)) return undefined;
  if (acknowledged !== undefined && acknowledged !== true) return undefined;
  return { account, ...(acknowledged === true && { acknowledged: true as const }) };
};

export const readLfs = async (
  db: Db,
  userId: string,
  access: AccessPolicy = OWNER_ONLY,
): Promise<LfsAccount> => {
  const [prefs] = await db
    .select({ at: userPrefs.lfsAcknowledgedAt })
    .from(userPrefs)
    .where(eq(userPrefs.userId, userId));
  const rows = await db
    .select({
      repo: projectRepos.repoId,
      owner: projectRepos.ownerLogin,
      name: projectRepos.name,
      project: projects.id,
      projectName: projects.name,
      files: sql<string>`count(${lfsObjects.oid})`,
      bytes: sql<string>`coalesce(sum(${lfsObjects.size}), 0)`,
    })
    .from(projects)
    .innerJoin(projectRepos, eq(projectRepos.projectId, projects.id))
    .innerJoin(lfsObjects, eq(lfsObjects.repoId, projectRepos.repoId))
    .where(access.visible(userId))
    .groupBy(
      projectRepos.repoId,
      projectRepos.ownerLogin,
      projectRepos.name,
      projects.id,
      projects.name,
    );
  const repositories = rows
    .map((row) => ({
      repo: row.repo,
      fullName: `${row.owner}/${row.name}`,
      url: `https://github.com/${encodeURIComponent(row.owner)}/${encodeURIComponent(row.name)}`,
      project: { id: row.project, name: row.projectName },
      files: Number(row.files),
      bytes: Number(row.bytes),
    }))
    .toSorted((a, b) => b.bytes - a.bytes || a.fullName.localeCompare(b.fullName));
  return {
    ...(prefs?.at && { acknowledgedAt: prefs.at.getTime() }),
    repositories,
  };
};

/**
 * What a person said of the storage: that they know what it means, kept as the first time they
 * said it. Answers everything as it is then. Where new assets of a project go is the project's
 * own (`defaultStorage` of the format); `projects.lfs_auto` of before stays unread, for an older
 * platform rolled back to.
 */
export const changeLfs = async (
  db: Db,
  userId: string,
  changes: LfsChanges,
  now: number,
): Promise<LfsAccount> => {
  if (changes.acknowledged)
    await db.transaction(async (tx) => {
      const row = await lockPrefs(tx, userId, "update");
      if (row.lfsAcknowledgedAt) return;
      await tx
        .update(userPrefs)
        .set({ lfsAcknowledgedAt: new Date(now) })
        .where(eq(userPrefs.userId, userId));
    });
  return readLfs(db, userId);
};
