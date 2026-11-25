import { Archiver } from "./archive/archiver.ts";
import { EXPORT_HEAP_MB, ProjectExporter } from "./archive/exporter.ts";
import { GitHubRepoHost } from "./archive/github-host.ts";
import { Rebuilder, setUpRebuildQueues, startRebuilding } from "./archive/rebuild.ts";
import { scheduleLocalChecks } from "./archive/local/checks.ts";
import type { LocalGitRepoHost } from "./archive/local/host.ts";
import { linkUnlinked, startLocalRepos } from "./archive/local/links.ts";
import { RepoHosts } from "./archive/repo-host.ts";
import { STOP_WAIT_MS, enqueueArchive, startArchiving } from "./archive/schedule.ts";
import type { Config } from "./config.ts";
import {
  createDatabase,
  describeError,
  type Db,
  type Logger,
  type MigrationSet,
} from "./database.ts";
import { GitHubApp } from "./github/app.ts";
import { startJobs, type Jobs } from "./jobs.ts";
import { enqueuePush, startLfs } from "./lfs/jobs.ts";
import { LfsPusher } from "./lfs/push.ts";
import { Staging } from "./lfs/staging.ts";
import { LfsSweeper } from "./lfs/sweep.ts";
import {
  enqueueRepoMerge,
  requeueWaitingMerges,
  setUpRepoMergeQueue,
} from "./sync/repo-merge-jobs.ts";

/**
 * The worker: archives projects into their repositories (archive/archiver.ts), makes working copies
 * again from them (archive/rebuild.ts), and puts files of assets that came in through the API into
 * the large file storage of their repository (lfs/), in a process of its own next to the API, so
 * that Git and large files never slow down syncing. It takes no requests: the API and the webhooks
 * queue archives and uploads, and every minute it queues the projects whose changes are due itself,
 * see archive/schedule.ts. It needs the database and the staging folder, and for GitHub the App's
 * private key; nothing of people's.
 *
 * Without the App's key there is no repository on GitHub to reach (`RepoHosts`): the queues and the
 * schedules run all the same, and nothing is archived there.
 *
 * One archive at a time, or one working copy made again. The project is made into files in a
 * thread whose heap is `EXPORT_HEAP_MB`: the largest project the server takes (16 MB as Yjs encodes
 * it) fits, see test/measure-archive.ts.
 */

/** What a deployment gives the worker besides the settings, see `startWorker`. */
export interface WorkerParts {
  readonly log: Logger;
  /** What a deployment migrates after the server's own, see database.ts. */
  readonly migrations?: readonly MigrationSet[];
  /** Asked before migrating, every try: a database this version must not migrate is refused here. */
  readonly beforeMigrate?: ((db: Db) => Promise<void>) | undefined;
  /** The name of its connections to the database. */
  readonly applicationName?: string;
  /** The repositories on GitHub: from the App's key in the settings unless said, as for tests. */
  readonly github?: GitHubRepoHost | undefined;
  /**
   * The repositories of the server's own (archive/local/): as the settings say unless said
   * (`startLocalRepos`); a deployment that never keeps any says undefined.
   */
  readonly local?: LocalGitRepoHost | undefined;
}

export interface Worker {
  /** Until it is set up, or gave up as it was stopped. */
  readonly ready: Promise<void>;
  /** Lets what runs finish, within what an archive may wait (`STOP_WAIT_MS`), and stops. */
  stop(): Promise<void>;
}

/** The repositories on GitHub, where the App's key is set: undefined where it is not. */
const gitHubOf = (config: Config, log: Logger): GitHubRepoHost | undefined => {
  const { github } = config;
  if (!github.privateKey || !github.clientId) {
    log.warn({}, "GITHUB_APP_PRIVATE_KEY or GITHUB_CLIENT_ID is not set: nothing goes to GitHub");
    return undefined;
  }
  for (const problem of github.problems) log.warn({}, `GitHub App: ${problem}`);
  const app = new GitHubApp({
    apiUrl: github.apiUrl,
    issuer: github.clientId,
    privateKey: github.privateKey,
  });
  return new GitHubRepoHost(app, { apiUrl: github.apiUrl, webUrl: github.webUrl });
};

/**
 * Starts the worker: migrations (the API migrates too, whoever is first does it under a lock), the
 * job queue, and the work, tried again with a growing wait until the database is there.
 */
export const startWorker = (config: Config, parts: WorkerParts): Worker => {
  const { log } = parts;
  let stopping = false;
  let jobs: Jobs | undefined;
  const database = createDatabase(
    config.database,
    log,
    parts.applicationName ?? "animaquill-worker",
    parts.migrations ?? [],
  );
  const github = "github" in parts ? parts.github : gitHubOf(config, log);
  let hosts = new RepoHosts({ github });

  /**
   * Uploads into the large file storage, where the staging folder is there: pushes, and the sweep
   * every 15 minutes. What a worker before this one was pushing when it stopped goes on now, as it
   * is the only one.
   */
  const pushing = async (boss: Jobs) => {
    const staging = new Staging(config.stagingDir);
    if (!(await staging.usable())) {
      log.warn(
        {},
        `${config.stagingDir} is not a folder the worker may use: no uploads to Git LFS`,
      );
      return;
    }
    const db = database.db;
    const sweeper = new LfsSweeper({ db, staging, log });
    await startLfs(boss, { pusher: new LfsPusher({ db, hosts, staging, log }), sweeper, log });
    const swept = await sweeper.sweep({ resume: true });
    for (const upload of swept.due) await enqueuePush(boss, upload);
    log.info({ due: swept.due.length }, "pushing to Git LFS");
  };

  const prepare = async () => {
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `stop` sets it meanwhile
    for (let wait = 1000; !stopping; wait = Math.min(wait * 2, 30_000)) {
      try {
        await parts.beforeMigrate?.(database.db);
        await database.migrate();
        const local =
          "local" in parts ? parts.local : await startLocalRepos(config, log, database.db);
        hosts = new RepoHosts({ github, local });
        jobs = await startJobs(config.database, log);
        // What an archive finds changed in the repository, the API merges into the working copy.
        await setUpRepoMergeQueue(jobs);
        const requeued = await requeueWaitingMerges(database.db, jobs);
        if (requeued > 0) log.info({ merges: requeued }, "merges that wait queued again");
        const merges = jobs;
        const archiver = new Archiver({
          db: database.db,
          hosts,
          exporter: new ProjectExporter({ heapMb: EXPORT_HEAP_MB }),
          log,
          enqueueMerge: (merge) => enqueueRepoMerge(merges, merge),
        });
        // One project at a time, archived or made again: each takes an export thread of its own.
        let turn: Promise<unknown> = Promise.resolve();
        const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
          const run = turn.then(work, work);
          turn = run.catch(() => {});
          return run;
        };
        await startArchiving(jobs, {
          db: database.db,
          archiver: { run: (...args) => inTurn(() => archiver.run(...args)) },
          log,
          providers: hosts.providers,
        });
        const queue = jobs;
        // Working copies the server let go of, made again from the repository as they are asked for:
        // only where a repository can be reached. Without one, what is asked for waits in the queue,
        // as archives wait: a try would fail, and enough of them would take the project away.
        if (hosts.providers.length === 0) await setUpRebuildQueues(jobs);
        else {
          const rebuilder = new Rebuilder({
            db: database.db,
            hosts,
            exporter: new ProjectExporter({ heapMb: EXPORT_HEAP_MB }),
            log,
            // Changes in the repository since the archive the copy is made from: an archive that
            // looks finds them.
            lookAgain: (project) => enqueueArchive(queue, { project, kind: "check" }),
          });
          await startRebuilding(jobs, {
            db: database.db,
            rebuilder: { run: (project) => inTurn(() => rebuilder.run(project)) },
            log,
          });
        }
        if (local) {
          // Without GitHub every project is saved here: those from before have a repository now.
          if (!github) await linkUnlinked(database.db, new Date(), log);
          await scheduleLocalChecks(queue, {
            db: database.db,
            host: local,
            log,
            look: (project) => enqueueArchive(queue, { project, kind: "check" }),
          });
        }
        log.info({ providers: hosts.providers }, "archiving");
        await pushing(jobs);
        return;
      } catch (error) {
        log.error({ err: describeError(error) }, `not ready, next try in ${wait / 1000} s`);
        await jobs?.stop({ graceful: false }).catch(() => {});
        jobs = undefined;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };

  const ready = prepare();
  return {
    ready,
    async stop() {
      if (stopping) return;
      stopping = true;
      // An archive that does not finish in time is safe to stop: the next one knows what reached
      // the repository. Whatever runs the worker gives it longer than this before it kills it.
      await jobs?.stop({ graceful: true, timeout: STOP_WAIT_MS }).catch(() => {});
      await database.close().catch(() => {});
    },
  };
};

const LEVELS = { info: 30, warn: 40, error: 50 } as const;

/** Lines of JSON, as the API logs them, without a library for it. */
export const jsonLogger = (name: string): Logger => {
  const line = (level: keyof typeof LEVELS) => (object: object, message?: string) => {
    const text = JSON.stringify({
      level: LEVELS[level],
      time: Date.now(),
      name,
      ...object,
      ...(message !== undefined && { msg: message }),
    });
    (level === "info" ? process.stdout : process.stderr).write(`${text}\n`);
  };
  return { info: line("info"), warn: line("warn"), error: line("error") };
};

/**
 * Stops on SIGTERM or SIGINT, once, and ends the process then; meanwhile it stays up when there is
 * nothing to do, as a process that is meant to run.
 */
export const runUntilStopped = (log: Logger, stop: () => Promise<void>) => {
  let stopping = false;
  const end = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "stopping");
    await stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", () => void end("SIGTERM"));
  process.on("SIGINT", () => void end("SIGINT"));
  setInterval(() => {}, 60 * 60_000);
};
