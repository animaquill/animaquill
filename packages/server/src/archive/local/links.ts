import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { localReposOn, type Config } from "../../config.ts";
import type { Db, Executor, Logger } from "../../database.ts";
import type { LocalLfs } from "../../lfs/uploads.ts";
import { projectRepos, projects } from "../../schema.ts";
import { LocalGitRepoHost, REPOS_FOLDER, ReposMissing, localDirOf } from "./host.ts";

/**
 * Projects saved to repositories of the server's own (`provider` "local"), where it keeps those and
 * is not set up for GitHub: a project has one from when it is made (the hub links it in the same
 * transaction), and the worker links those that have none as it starts. The repository itself is
 * made by the first archive (archiver.ts): nothing here touches it. Also how their large file
 * storage is set up as a process starts (`localLfsOf`, `prepareLocalStaging`).
 */

/** The next number of a repository of the server's own. */
const nextRepoId = async (tx: Executor): Promise<number> => {
  const { rows } = await tx.execute<{ id: string }>(sql`select nextval('local_repo_ids') as id`);
  return Number(rows[0]!.id);
};

/**
 * Saves a project to a repository of the server's own, in `dir` (`repos/<project>.git` unless said,
 * as for one that is restored), archived as soon as the worker gets to it.
 */
export const linkLocal = async (
  tx: Executor,
  link: {
    readonly projectId: string;
    readonly userId: string | null;
    readonly at: Date;
    readonly dir?: string;
    readonly createdHere?: boolean;
  },
): Promise<number> => {
  const repoId = await nextRepoId(tx);
  const dir = link.dir ?? localDirOf(link.projectId);
  await tx.insert(projectRepos).values({
    projectId: link.projectId,
    provider: "local",
    installationId: null,
    repoId,
    localDir: dir,
    ownerId: 0,
    ownerLogin: "",
    name: dir.replace(/^repos\//, "").replace(/\.git$/, ""),
    branch: "main",
    private: true,
    createdHere: link.createdHere ?? true,
    linkedBy: link.userId,
    linkedAt: link.at,
    checkedAt: link.at,
    requestedAt: link.at,
    requestedBy: link.userId,
  });
  return repoId;
};

/** Links every project without a repository to one of the server's own. Resolves to how many. */
export const linkUnlinked = async (db: Db, at: Date, log: Logger): Promise<number> => {
  const without = await db
    .select({ id: projects.id, ownerId: projects.ownerId })
    .from(projects)
    .leftJoin(projectRepos, eq(projectRepos.projectId, projects.id))
    .where(isNull(projectRepos.projectId));
  let linked = 0;
  for (const project of without) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select 1 from ${projects} where ${projects.id} = ${project.id} for update`,
        );
        const [there] = await tx
          .select({ id: projectRepos.projectId })
          .from(projectRepos)
          .where(and(eq(projectRepos.projectId, project.id)));
        if (there) return;
        await linkLocal(tx, { projectId: project.id, userId: project.ownerId, at });
        linked += 1;
      });
    } catch (error) {
      // A project deleted meanwhile, or whatever else: the next start tries again.
      log.warn({ project: project.id, err: String(error) }, "not linked to a repository here");
    }
  }
  if (linked > 0) log.info({ projects: linked }, "projects linked to repositories here");
  return linked;
};

/**
 * The repositories of the server's own, as a process starts: only where they are on (`localReposOn`:
 * no GitHub App, or AQ_LOCAL_REPOS=on) and `repos/` in the data folder can be used (`prepare`).
 * Says in the log whether they are on, and where.
 */
export const startLocalRepos = async (
  config: Config,
  log: Logger,
  db?: Db,
): Promise<LocalGitRepoHost | undefined> => {
  if (!localReposOn(config)) {
    log.info({}, "repositories here are off: projects are saved to GitHub only");
    return undefined;
  }
  const host = new LocalGitRepoHost({ dataDir: config.dataDir, log });
  // Projects were archived here: a folder that is not there is a volume that is not, never one to
  // make anew, which would turn every repository into one that is gone.
  const archivedHere =
    db !== undefined &&
    (
      await db
        .select({ id: projectRepos.projectId })
        .from(projectRepos)
        .where(and(eq(projectRepos.provider, "local"), isNotNull(projectRepos.headSha)))
        .limit(1)
    ).length > 0;
  try {
    const found = await host.prepare({ mayMake: !archivedHere });
    log.info(
      { repos: host.pathOf({ dir: "repos" }), found },
      found === "made"
        ? "repositories here are on, in a folder made now: it has to be on a volume that stays"
        : "repositories here are on",
    );
    return host;
  } catch (error) {
    if (error instanceof ReposMissing) {
      // Kept on, so that archives say "cannot be reached now" until the volume is there.
      log.error(
        { repos: host.pathOf({ dir: "repos" }), err: String(error) },
        "the folder of repositories here is not there: is the data volume mounted? Archives wait",
      );
      return host;
    }
    log.error(
      { repos: host.pathOf({ dir: "repos" }), err: String(error) },
      "repositories here are off: the folder of repositories cannot be used",
    );
    return undefined;
  }
};

/**
 * The large file storage of the server's own repositories, as uploads count against it (see
 * lfs/uploads.ts), from what the server is set up for.
 */
export const localLfsOf = (config: Config, host: LocalGitRepoHost): LocalLfs => {
  const gib = 1024 ** 3;
  let reposDevice: Promise<number | undefined> | undefined;
  const deviceOf = async (path: string) => (await stat(path).catch(() => undefined))?.dev;
  return {
    fileBytes: Math.floor(config.localLfs.fileMaxGb * gib),
    maxBytes:
      config.localLfs.maxGb === undefined ? undefined : Math.floor(config.localLfs.maxGb * gib),
    stagingFloorBytes:
      config.stagingFloorGb === undefined ? undefined : config.stagingFloorGb * gib,
    room: () => host.room(),
    async sameDisk(path) {
      reposDevice ??= deviceOf(host.pathOf({ dir: REPOS_FOLDER }));
      const [repos, other] = await Promise.all([reposDevice, deviceOf(path)]);
      if (repos === undefined) reposDevice = undefined;
      return repos !== undefined && repos === other;
    },
  };
};

/**
 * The staging folder where the server's own repositories are on, as a process starts: made where
 * it is `staging/` of the data folder and not there yet (only the server's, 0700); said in the
 * log whether it is on the disk of the repositories, where a file goes into its repository as a
 * second name of it, or on another one, where each is copied, and needs room twice.
 */
export const prepareLocalStaging = async (
  config: Config,
  host: LocalGitRepoHost,
  log: Logger,
): Promise<void> => {
  if (resolve(config.stagingDir) === resolve(config.dataDir, "staging"))
    await mkdir(config.stagingDir, { recursive: true, mode: 0o700 }).catch((error: unknown) => {
      log.warn({ err: String(error) }, "the staging folder is not made");
    });
  const same = await localLfsOf(config, host).sameDisk(config.stagingDir);
  if (same)
    log.info({ staging: config.stagingDir }, "large files go into repositories here as they are");
  else
    log.warn(
      { staging: config.stagingDir },
      "the staging folder is not on the disk of the repositories here: each large file is copied, and needs room twice",
    );
};
