import type { FastifyInstance } from "fastify";
import { OWNER_ONLY, type AccessPolicy } from "./access.ts";
import { buildApp, type Platform } from "./app.ts";
import { GitHubPersonRepos, GitHubRepoHost } from "./archive/github-host.ts";
import type { Link } from "./archive/links.ts";
import { recheckLink } from "./archive/recheck.ts";
import { enqueueRebuild, setUpRebuildQueues } from "./archive/rebuild.ts";
import type { LocalGitRepoHost } from "./archive/local/host.ts";
import { localLfsOf, prepareLocalStaging, startLocalRepos } from "./archive/local/links.ts";
import { RepoHosts } from "./archive/repo-host.ts";
import {
  enqueueArchive,
  isArchiveQueued,
  setUpArchiveQueues,
  type ArchiveJob,
} from "./archive/schedule.ts";
import { RepositoryService } from "./archive/service.ts";
import type { PeoplePolicy } from "./auth/people.ts";
import { setUpAccounts, type AccountsSetup } from "./auth/setup.ts";
import { whenSignedOutEverywhere } from "./auth/tokens.ts";
import type { Config } from "./config.ts";
import {
  createDatabase,
  describeError,
  type Db,
  type Logger,
  type MigrationSet,
} from "./database.ts";
import { GitHubApp } from "./github/app.ts";
import type { ProjectHolds } from "./holds.ts";
import { scheduleCleanup, startJobs, type Jobs } from "./jobs.ts";
import { LfsDownloads } from "./lfs/downloads.ts";
import { enqueuePush, setUpLfsQueues } from "./lfs/jobs.ts";
import { Staging } from "./lfs/staging.ts";
import { LfsUploads } from "./lfs/uploads.ts";
import { libraryMode } from "./library/config.ts";
import { LibraryStorage } from "./library/storage.ts";
import type { PersonLimits } from "./limits.ts";
import { ChatImages, scheduleChatImagesCleanup, settleLater } from "./me/chat-images.ts";
import { listenForPeople, PersonEvents } from "./me/events.ts";
import { Settings } from "./settings.ts";
import type { ReleaseSwitches } from "./switches.ts";
import { SyncHub } from "./sync/hub.ts";
import { listenForLinks } from "./sync/link-listener.ts";
import { workRepoMerges } from "./sync/repo-merge-jobs.ts";
import { scheduleProjectSweep, scheduleRechecks } from "./sync/sweep.ts";

/**
 * The API: the HTTP side (app.ts) with everything it works with, made once the database is there.
 * It answers from the start, with 503 on /api/health until migrations and the job queue are in
 * place, and a database that is not up yet is waited for, not a reason to stop. What a deployment
 * has besides (its own tables, routes, jobs) comes in by `ServerParts`.
 */

/** What the API works with once the database is ready, for what a deployment adds. */
export interface ServerReady {
  readonly db: Db;
  readonly jobs: Jobs;
  readonly hub: SyncHub;
  readonly log: Logger;
}

/** What a deployment gives the API besides the settings, see `startServer`. */
export interface ServerParts {
  /** Who may do what with which project, see access.ts: only the owner unless said. */
  readonly access?: AccessPolicy;
  /** Who may get an account, see auth/people.ts: nobody new unless said. */
  readonly people?: PeoplePolicy;
  /** How much each person may have, see limits.ts: nothing is limited unless said. */
  readonly limits?: PersonLimits;
  /** What else may change a project, see holds.ts: nothing unless said. */
  readonly holds?: ProjectHolds;
  /** The switches of a release, see switches.ts. */
  readonly switches?: ReleaseSwitches;
  /** What a deployment migrates after the server's own, see database.ts. */
  readonly migrations?: readonly MigrationSet[];
  /** Asked before migrating, every try: a database this version must not migrate is refused here. */
  readonly beforeMigrate?: ((db: Db) => Promise<void>) | undefined;
  /**
   * Makes the HTTP side from what the server gives it: `buildApp` unless said, which a deployment
   * wraps with what it has besides (`Platform.extend`).
   */
  readonly build?: (config: Config, platform: Platform) => FastifyInstance;
  /**
   * What a deployment starts once the database is ready, after the server's own: its jobs, as an
   * admin's or cloud AI's. What fails of it is logged and waits for the next start.
   */
  readonly prepared?: ((ready: ServerReady) => Promise<void>) | undefined;
  /** What a deployment tidies up every hour with accounts, see `scheduleCleanup`. */
  readonly cleanUp?: ((db: Db) => Promise<Record<string, number>>) | undefined;
  /**
   * The repositories of the server's own (archive/local/): as the settings say unless said
   * (`startLocalRepos`); a deployment that never keeps any says undefined.
   */
  readonly local?: LocalGitRepoHost | undefined;
  /**
   * GiB one person may download a day through the server where admins set nothing (lfs/downloads.ts):
   * no limit unless said.
   */
  readonly lfsDailyGb?: number | undefined;
  /**
   * Accounts also without the GitHub App, see `setUpAccounts`: for the person of this machine, as
   * the backend of `npx animaquill` has them.
   */
  readonly withoutGitHub?: boolean | undefined;
  /**
   * Where the app takes requests: `app.listen` on the host and port of the settings unless said.
   * The backend of `npx animaquill` has servers of its own, which hand the app what is for it.
   */
  readonly serve?: ((app: FastifyInstance) => Promise<void>) | undefined;
}

export interface Server {
  readonly app: FastifyInstance;
  readonly log: Logger;
  /** Accounts, as far as the settings allow, see auth/setup.ts. */
  readonly accounts: AccountsSetup;
  /** Listens where the settings say, and makes the rest ready behind it. */
  listen(): Promise<void>;
  /** Once the database is ready behind it, as /api/health says it; never, if stopped first. */
  whenReady(): Promise<void>;
  /** Stops answering, and what runs behind. */
  stop(): Promise<void>;
}

export const startServer = (config: Config, parts: ServerParts = {}): Server => {
  const access = parts.access ?? OWNER_ONLY;
  const switches = parts.switches;
  let ready = false;
  let madeReady: () => void = () => {};
  const readyNow = new Promise<void>((resolve) => {
    madeReady = resolve;
  });
  let stopping = false;
  let jobs: Jobs | undefined;
  let sync: SyncHub | undefined;
  let repositories: RepositoryService | undefined;
  let lfs: LfsUploads | undefined;
  let lfsDownloads: LfsDownloads | undefined;
  let chatImages: ChatImages | undefined;
  let settings: Settings | undefined;
  let links: ReturnType<typeof listenForLinks> | undefined;
  let people: ReturnType<typeof listenForPeople> | undefined;

  /** Archives that webhooks or people ask for: the worker runs them, see worker.ts. */
  const enqueue = async (job: ArchiveJob) => {
    if (!jobs) throw new Error("the job queue is not there yet");
    await enqueueArchive(jobs, job);
  };

  /** Working copies the server let go of, which the worker makes again: see archive/rebuild.ts. */
  const rebuild = async (project: string) => {
    if (!jobs) throw new Error("the job queue is not there yet");
    await enqueueRebuild(jobs, project);
  };

  /** The pages that hear at once what changed of their person's list, see me/events.ts. */
  const events = new PersonEvents();
  const app = (parts.build ?? buildApp)(config, {
    access,
    events,
    checkDatabase: () => database.check(),
    ready: () => ready,
    accounts: () => accounts.accounts,
    installUrl: () => accounts.installUrl,
    onGitHubEvent: (event, payload, delivery) => accounts.onGitHubEvent(event, payload, delivery),
    sync: () => sync,
    db: () => database.db,
    repositories: () => repositories,
    lfs: () => lfs,
    lfsDownloads: () => lfsDownloads,
    chatImages: () => chatImages,
    settings: () => settings,
    rebuild,
    ...(parts.limits && { limits: parts.limits }),
    ...(switches && { switches }),
  });
  const log: Logger = app.log;
  const database = createDatabase(config.database, log, "animaquill-api", parts.migrations ?? []);
  const accounts = setUpAccounts(config, database.db, {
    log,
    ...(parts.people && { people: parts.people }),
    ...(parts.withoutGitHub && { withoutGitHub: true }),
    events: {
      async onArchives(wanted) {
        for (const job of wanted)
          await enqueue(job).catch((error: unknown) => {
            log.warn({ err: describeError(error), project: job.project }, "no archive queued");
          });
      },
    },
  });
  for (const problem of config.github.problems) app.log.warn(`GitHub App: ${problem}`);
  for (const problem of [...config.problems, ...accounts.problems])
    app.log.warn(`Sign-in: ${problem}`);
  for (const problem of config.relay.problems) app.log.warn(`Relay: ${problem}`);
  for (const problem of config.library.problems) app.log.warn(`Library: ${problem}`);

  /** The GitHub App, with its own key: undefined where that is not set. */
  const appOf = (): GitHubApp | undefined => {
    const { github } = config;
    if (!github.privateKey || !github.clientId) return undefined;
    return new GitHubApp({
      apiUrl: github.apiUrl,
      issuer: github.clientId,
      privateKey: github.privateKey,
    });
  };

  /**
   * Saving projects to GitHub, where the App is set up for it: its key for checking repositories
   * as an archive will find them, and people's tokens for what only those can do.
   */
  const repositoryService = (
    found: GitHubRepoHost | undefined,
    githubApp: GitHubApp | undefined,
    local: LocalGitRepoHost | undefined,
  ): RepositoryService | undefined => {
    const { github } = config;
    const tokenFor = accounts.githubTokenFor;
    const host = tokenFor ? found : undefined;
    if (!host)
      app.log.warn("Saving to GitHub is off: the App's private key or client id is not set");
    if (!host && !local) return undefined;
    const queue = jobs as Jobs;
    return new RepositoryService({
      access,
      db: database.db,
      host,
      people: host && new GitHubPersonRepos({ apiUrl: github.apiUrl }),
      local,
      tokenFor,
      enqueue,
      rebuild,
      isQueued: (project) => isArchiveQueued(queue, project),
      webUrl: github.webUrl,
      log,
      app: githubApp,
      deletesFrom: switches?.deletesFrom,
    });
  };

  /**
   * Files of assets into the large file storage through the server, where a repository can be
   * reached and the staging folder is there to write into: the worker pushes them on.
   */
  const lfsUploads = async (hosts: RepoHosts): Promise<LfsUploads | undefined> => {
    const staging = new Staging(config.stagingDir);
    if (hosts.providers.length === 0) return undefined;
    if (hosts.local) await prepareLocalStaging(config, hosts.local, log);
    if (!(await staging.usable())) {
      app.log.warn(
        `Uploads to Git LFS are off: ${config.stagingDir} is not a folder the API may write`,
      );
      return undefined;
    }
    const queue = jobs as Jobs;
    return new LfsUploads({
      db: database.db,
      staging,
      hosts,
      local: hosts.local && localLfsOf(config, hosts.local),
      enqueue: (upload) => enqueuePush(queue, upload),
      log,
      ...(config.stagingFloorGb !== undefined && {
        limits: { floorBytes: config.stagingFloorGb * 1024 ** 3 },
      }),
    });
  };

  const prepare = async () => {
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- `stop` sets it meanwhile
    for (let wait = 1000; !stopping; wait = Math.min(wait * 2, 30_000)) {
      try {
        await parts.beforeMigrate?.(database.db);
        await database.migrate();
        jobs = await startJobs(config.database, log);
        await setUpArchiveQueues(jobs);
        await setUpLfsQueues(jobs);
        await setUpRebuildQueues(jobs);
        const local =
          "local" in parts ? parts.local : await startLocalRepos(config, log, database.db);
        const githubApp = appOf();
        const github =
          githubApp &&
          new GitHubRepoHost(githubApp, {
            apiUrl: config.github.apiUrl,
            webUrl: config.github.webUrl,
          });
        const hub = new SyncHub({
          db: database.db,
          log,
          ...(parts.holds && { holds: parts.holds }),
          access,
          oldestEditor: switches?.oldestEditor,
          // A repository nobody looked at for an hour, when a window opens its project.
          lookAgain: (project) => enqueue({ project, kind: "check" }),
          // A working copy the server let go of, when a window of its owner comes for it.
          rebuild,
          // A merge from the repository changed the project: it goes back with the next archive.
          merged: (project) => enqueue({ project, kind: "auto" }),
          // Without GitHub every new project is saved to a repository of the server's own.
          linkLocal: local !== undefined && github === undefined,
        });
        // Changes in repositories that the worker found, merged into the working copies here.
        await workRepoMerges(jobs, hub, log);
        sync = hub;
        // What other processes change of links, as an archive that finds the repository gone.
        await links?.stop().catch(() => {});
        links = listenForLinks(database.db, hub, log);
        // ...and of people's lists, whichever process changed them.
        await people?.stop().catch(() => {});
        people = listenForPeople(database.db, events, log);
        const hosts = new RepoHosts({ github, local });
        repositories = repositoryService(github, githubApp, local);
        lfs = await lfsUploads(hosts);
        // Out of the large file storage needs no staging: what comes is passed on as it comes.
        lfsDownloads =
          hosts.providers.length === 0
            ? undefined
            : new LfsDownloads({
                db: database.db,
                hosts,
                log,
                settings: () => settings,
                dailyGb: parts.lfsDailyGb,
              });
        // Files that were all there when the API stopped, before they were read through.
        void lfs?.settleWaiting().catch((error: unknown) => {
          log.warn({ err: describeError(error) }, "uploads that wait for their check stay for now");
        });
        settings = new Settings({ db: database.db, log });
        // The pictures of conversations, in the storage of the cloud space, and their hourly round.
        const storage = LibraryStorage.of(config.library);
        const queue = jobs;
        const images = new ChatImages({
          db: database.db,
          storage,
          mode: () => libraryMode(config.library),
          checksum: config.library.checksum,
          minFreeBytes: config.library.minFreeBytes,
          settings: () => settings,
          log,
          ...(storage && jobs && { later: (job) => settleLater(queue, job) }),
        });
        chatImages = images;
        if (storage)
          await scheduleChatImagesCleanup(jobs, images, log).catch((error: unknown) => {
            log.warn(
              { err: describeError(error) },
              "pictures of conversations will not be tidied up",
            );
          });
        // Signed out everywhere, as after taking the App's authorization back: syncing stops too.
        whenSignedOutEverywhere((userId) => sync?.closeUser(userId));
        // What the deployment has besides: neither holds up the rest, what fails waits.
        await parts.prepared?.({ db: database.db, jobs, hub, log });
        const recheck =
          github && ((link: Link) => recheckLink(database.db, github, link, new Date(), githubApp));
        // Every hour: projects whose repository cannot be used for a week go, once GitHub says so
        // again; ids of deleted projects are forgotten after a week. What fails waits.
        await scheduleProjectSweep(jobs, {
          db: database.db,
          hub,
          log,
          deletesFrom: switches?.deletesFrom,
          recheck,
          lookAgain: (project) => enqueue({ project, kind: "check" }),
        }).catch((error: unknown) => {
          log.warn({ err: describeError(error) }, "projects will not be swept");
        });
        // Every minute: repositories that cannot be used are asked about again as they are due.
        if (recheck)
          await scheduleRechecks(jobs, {
            db: database.db,
            recheck,
            lookAgain: (project) => enqueue({ project, kind: "check" }),
            log,
          }).catch((error: unknown) => {
            log.warn({ err: describeError(error) }, "repositories will not be asked about again");
          });
        const work = accounts.accounts;
        const cleanUp = parts.cleanUp;
        // Tidying up can wait for the next start; signing in cannot wait for it.
        if (work)
          await scheduleCleanup(
            jobs,
            async () => ({
              ...(await work.cleanUp()),
              ...(cleanUp && (await cleanUp(database.db))),
            }),
            log,
          ).catch((error: unknown) => {
            log.warn({ err: describeError(error) }, "accounts will not be tidied up");
          });
        ready = true;
        madeReady();
        log.info({}, "database ready");
        return;
      } catch (error) {
        log.error(
          { err: describeError(error) },
          `database not ready, next try in ${wait / 1000} s`,
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };

  return {
    app,
    log,
    accounts,
    async listen() {
      if (parts.serve) await parts.serve(app);
      else await app.listen({ host: config.host, port: config.port });
      void prepare();
    },
    whenReady: () => readyNow,
    async stop() {
      if (stopping) return;
      stopping = true;
      await app.close().catch(() => {});
      await people?.stop().catch(() => {});
      await links?.stop().catch(() => {});
      await jobs?.stop({ graceful: true, timeout: 10_000 }).catch(() => {});
      await database.close().catch(() => {});
    },
  };
};
