import { and, eq, isNull, sql } from "drizzle-orm";
import { localReposOn, type Config } from "../../config.ts";
import type { Db, Executor, Logger } from "../../database.ts";
import { projectRepos, projects } from "../../schema.ts";
import { LocalGitRepoHost, localDirOf } from "./host.ts";

/**
 * Projects saved to repositories of the server's own (`provider` "local"), where it keeps those and
 * is not set up for GitHub: a project has one from when it is made (the hub links it in the same
 * transaction), and the worker links those that have none as it starts. The repository itself is
 * made by the first archive (archiver.ts): nothing here touches the disk.
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
): Promise<LocalGitRepoHost | undefined> => {
  if (!localReposOn(config)) {
    log.info({}, "repositories here are off: projects are saved to GitHub only");
    return undefined;
  }
  const host = new LocalGitRepoHost({ dataDir: config.dataDir, log });
  try {
    const found = await host.prepare();
    log.info(
      { repos: host.pathOf({ dir: "repos" }), found },
      found === "made"
        ? "repositories here are on, in a folder made now: it has to be on a volume that stays"
        : "repositories here are on",
    );
    return host;
  } catch (error) {
    log.error(
      { repos: host.pathOf({ dir: "repos" }), err: String(error) },
      "repositories here are off: the folder of repositories cannot be used",
    );
    return undefined;
  }
};
