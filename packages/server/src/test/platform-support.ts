import { createHmac, randomBytes } from "node:crypto";
import type { Archiver } from "../archive/archiver.ts";
import { GitHubPersonRepos } from "../archive/github-host.ts";
import type { ArchiveJob } from "../archive/schedule.ts";
import { RepositoryService } from "../archive/service.ts";
import { buildApp, type Platform as ServerPlatform } from "../app.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { REQUEST_HEADER } from "../auth/guard.ts";
import { setUpAccounts } from "../auth/setup.ts";
import { storeTokens } from "../auth/tokens.ts";
import { loadConfig } from "../config.ts";
import type { Logger } from "../database.ts";
import { sessions } from "../schema.ts";
import { createSealer, hashOf, randomToken } from "../seal.ts";
import type { LfsDownloads } from "../lfs/downloads.ts";
import type { LfsUploads } from "../lfs/uploads.ts";
import type { ChatImages } from "../me/chat-images.ts";
import type { SyncHub } from "../sync/hub.ts";
import type { PersonLimits } from "../limits.ts";
import type { AccessPolicy } from "../access.ts";
import type { ReleaseSwitches } from "../switches.ts";
import { API, type World } from "./archive-support.ts";
import { FakeGitHub, type FakeDelivery } from "./fake-github.ts";

/**
 * The platform as the editor reaches it, for tests of saving to GitHub: the HTTP API with a person
 * signed in, the webhook, and a queue of archives that the test runs itself, as the worker would.
 */

export const ORIGIN = "https://editor.example.com";
export const WEB = "https://github.test";
export const WEBHOOK_SECRET = "webhook-secret";
const MASTER_KEY = `1:${randomBytes(32).toString("base64")}`;

export type Platform = Awaited<ReturnType<typeof platform>>;

export const platform = async (
  w: World,
  options: {
    readonly hub?: SyncHub;
    /** A queue of its own, such as pg-boss, in place of the one in memory. */
    readonly queue?: {
      enqueue(job: ArchiveJob): Promise<void>;
      isQueued(project: string): Promise<boolean>;
    };
    /** Uploads into Git LFS, see lfs-support.ts. */
    readonly lfs?: LfsUploads;
    /** Downloads out of Git LFS, see lfs-support.ts. */
    readonly lfsDownloads?: LfsDownloads;
    /** The pictures of conversations, with a storage of the tests, see objects.ts. */
    readonly chatImages?: ChatImages;
    /** The time of the limits of the routes, in milliseconds. */
    readonly now?: () => number;
    /**
     * The switches of a release, see src/switches.ts: as they are written in the code unless said,
     * as on the platform.
     */
    readonly switches?: ReleaseSwitches;
    /** Where what webhooks do is logged. */
    readonly log?: Logger;
    /** Has the working copy of a project made from its repository, as the worker would. */
    readonly rebuild?: (projectId: string) => Promise<void>;
    /** How long restoring waits for that, see `RepositoryService.restore`. */
    readonly restoreWaitMs?: number;
    /** Projects of one person, as restoring counts them. */
    readonly projectsPerUser?: number;
    /** Where the open catalog of models comes from, see src/ai/catalog.ts. */
    readonly modelCatalog?: { readonly fetch: typeof fetch };
    /** How much each person may have, see limits.ts. */
    readonly limits?: PersonLimits;
    /** Who may do what with which project, see access.ts: give the hub the same. */
    readonly access?: AccessPolicy;
    /** What the test adds to the server, as a deployment does, see app.ts. */
    readonly extend?: ServerPlatform["extend"];
  } = {},
) => {
  const config = loadConfig(
    {
      PUBLIC_ORIGIN: ORIGIN,
      GITHUB_APP_ID: String(w.github.appId),
      GITHUB_APP_SLUG: w.github.appSlug,
      GITHUB_CLIENT_ID: w.github.clientId,
      GITHUB_CLIENT_SECRET: w.github.clientSecret,
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_URL: WEB,
      GITHUB_API_URL: API,
      PLATFORM_MASTER_KEY: MASTER_KEY,
    },
    () => undefined,
  );
  /** Archives queued, as the worker would take them. */
  const queued: ArchiveJob[] = [];
  let fetch: typeof globalThis.fetch = w.github.fetch;
  const setup = setUpAccounts(config, w.db, {
    fetch: (input, init) => fetch(input, init),
    ...(options.log && { log: options.log }),
    events: {
      now: () => w.time.now,
      onArchives: async (jobs) => {
        queued.push(...jobs);
      },
    },
  });
  const service = new RepositoryService({
    db: w.db,
    host: w.host,
    people: new GitHubPersonRepos({ apiUrl: API, fetch: (input, init) => fetch(input, init) }),
    tokenFor: setup.githubTokenFor,
    // As the queue of archives does: a project waits there once.
    enqueue:
      options.queue?.enqueue ??
      (async (job) => {
        if (!queued.some((other) => other.project === job.project)) queued.push(job);
      }),
    isQueued:
      options.queue?.isQueued ?? (async (project) => queued.some((job) => job.project === project)),
    webUrl: WEB,
    app: w.app,
    ...(options.switches && { deletesFrom: options.switches.deletesFrom }),
    ...(options.rebuild && { rebuild: options.rebuild }),
    ...(options.restoreWaitMs !== undefined && { restoreWaitMs: options.restoreWaitMs }),
    ...(options.projectsPerUser !== undefined && { projectsPerUser: options.projectsPerUser }),
    ...(options.access && { access: options.access }),
  });
  const app = buildApp(
    config,
    {
      checkDatabase: async () => true,
      ready: () => true,
      accounts: () => setup.accounts,
      onGitHubEvent: (event, payload, delivery) => setup.onGitHubEvent(event, payload, delivery),
      sync: () => options.hub,
      db: () => w.db,
      repositories: () => service,
      lfs: () => options.lfs,
      lfsDownloads: () => options.lfsDownloads,
      chatImages: () => options.chatImages,
      ...(options.rebuild && { rebuild: options.rebuild }),
      ...(options.now && { now: options.now }),
      ...(options.switches && { switches: options.switches }),
      ...(options.modelCatalog && { modelCatalog: options.modelCatalog }),
      ...(options.limits && { limits: options.limits }),
      ...(options.access && { access: options.access }),
      ...(options.extend && { extend: options.extend }),
    },
    false,
  );

  // Signed in, with GitHub's tokens kept as signing in keeps them.
  const sessionId = randomToken();
  await w.db.insert(sessions).values({
    idHash: hashOf(sessionId),
    userId: w.userId,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  const sealer = createSealer(config.masterKeys!);
  await storeTokens(w.db, sealer, w.userId, {
    accessToken: w.github.grant(w.person),
    accessExpiresAt: new Date(Date.now() + 8 * 3600_000),
    refreshToken: undefined,
    refreshExpiresAt: undefined,
  });

  const request = async (
    method: "GET" | "POST" | "PUT",
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        cookie: `${SESSION_COOKIE}=${sessionId}`,
        ...(method !== "GET" && {
          origin: ORIGIN,
          [REQUEST_HEADER]: "1",
          "content-type": "application/json",
        }),
        ...headers,
      },
      ...(body !== undefined && { payload: JSON.stringify(body) }),
    });
    return { status: response.statusCode, json: response.json() as any, headers: response.headers };
  };

  /**
   * Any request as a page of the editor sends it, signed in and from this site unless said, with a
   * body as it is (a piece of a file, say) and headers of its own.
   */
  const send = async (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    how: {
      readonly payload?: string | Buffer;
      readonly headers?: Record<string, string>;
      readonly signedIn?: boolean;
      readonly fromHere?: boolean;
    } = {},
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(how.signedIn !== false && { cookie: `${SESSION_COOKIE}=${sessionId}` }),
        ...(method !== "GET" &&
          how.fromHere !== false && { origin: ORIGIN, [REQUEST_HEADER]: "1" }),
        ...how.headers,
      },
      ...(how.payload !== undefined && { payload: how.payload }),
    });
    let json: any;
    try {
      json = response.json();
    } catch {
      json = undefined;
    }
    return { status: response.statusCode, json, headers: response.headers };
  };

  /** A request whose answer is kept as the bytes it is, as a download. */
  const sendRaw = async (
    method: "GET" | "POST",
    url: string,
    how: { readonly headers?: Record<string, string>; readonly signedIn?: boolean } = {},
  ) => {
    const response = await app.inject({
      method,
      url,
      headers: {
        ...(how.signedIn !== false && { cookie: `${SESSION_COOKIE}=${sessionId}` }),
        ...how.headers,
      },
    });
    let json: any;
    try {
      json = response.json();
    } catch {
      json = undefined;
    }
    return {
      status: response.statusCode,
      body: response.rawPayload,
      json,
      headers: response.headers,
    };
  };

  /** A request with a body as it is, which need not be JSON. */
  const requestRaw = async (url: string, payload: string) => {
    const response = await app.inject({
      method: "POST",
      url,
      headers: {
        cookie: `${SESSION_COOKIE}=${sessionId}`,
        origin: ORIGIN,
        [REQUEST_HEADER]: "1",
        "content-type": "application/json",
      },
      payload,
    });
    return { status: response.statusCode, json: response.json() as any };
  };

  /** Passes on what GitHub would have sent to the webhook, signed. */
  const deliver = async (deliveries: readonly FakeDelivery[] = w.github.takeDeliveries()) => {
    const statuses: number[] = [];
    for (const delivery of deliveries) {
      const { body, headers } = FakeGitHub.signed(delivery, WEBHOOK_SECRET);
      const response = await app.inject({
        method: "POST",
        url: "/api/github/webhook",
        headers,
        payload: body,
      });
      statuses.push(response.statusCode);
    }
    return statuses;
  };

  /** Runs what is queued, as the worker would, one at a time. */
  const work = async (archiver: Archiver = w.archiver()) => {
    const outcomes = [];
    while (queued.length > 0) {
      const job = queued.shift() as ArchiveJob;
      outcomes.push(await archiver.run(job.project, job.kind, job.by));
    }
    return outcomes;
  };

  return {
    app,
    config,
    service,
    queued,
    request,
    requestRaw,
    send,
    sendRaw,
    deliver,
    work,
    /** Puts something in the way of what the platform asks GitHub. */
    intercept(next: typeof globalThis.fetch) {
      fetch = next;
    },
    sign: (body: string) =>
      `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
  };
};
