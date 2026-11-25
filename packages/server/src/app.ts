import { STATUS_CODES } from "node:http";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { accessGate, checkDeclared, OWNER_ONLY, type AccessPolicy } from "./access.ts";
import { repositoryRoutes } from "./archive/routes.ts";
import type { RepositoryService } from "./archive/service.ts";
import type { Accounts } from "./auth/accounts.ts";
import { authRoutes, type AdminHandoff } from "./auth/routes.ts";
import type { Config } from "./config.ts";
import { describeError, type Db } from "./database.ts";
import { webhookRoutes, type GitHubEventHandler } from "./github/webhook.ts";
import { lfsDownloadRoutes } from "./lfs/download-routes.ts";
import type { LfsDownloads } from "./lfs/downloads.ts";
import { lfsRoutes } from "./lfs/routes.ts";
import type { LfsUploads } from "./lfs/uploads.ts";
import type { ChatImages } from "./me/chat-images.ts";
import { trustedProxies, type TrustedProxies } from "./proxies.ts";
import { RelayExchanges } from "./relay/exchanges.ts";
import type { RelayLimits } from "./relay/gate.ts";
import { interfaceNetworks, type RelayNetwork } from "./relay/network.ts";
import { relayRoutes } from "./relay/routes.ts";
import { RELAY_PATH } from "./relay/target.ts";
import type { RelayUsage } from "./relay/use.ts";
import { RELAY_SETTING, type Settings } from "./settings.ts";
import type { SyncHub } from "./sync/hub.ts";
import { projectRoutes } from "./sync/routes.ts";
import { libraryMode } from "./library/config.ts";
import { meRoutes } from "./me/routes.ts";
import { personEventsRoutes, type PersonEvents } from "./me/events.ts";
import { ModelCatalogCache, catalogRoutes } from "./ai/catalog.ts";
import { createSealer } from "./seal.ts";
import type { PersonLimits } from "./limits.ts";
import type { ReleaseSwitches } from "./switches.ts";
import { syncSocket } from "./sync/socket.ts";

export interface Platform {
  /** The switches of a release, see switches.ts: as they are written, unless said. */
  readonly switches?: ReleaseSwitches;
  /** Whether the database answers now. */
  checkDatabase(): Promise<boolean>;
  /**
   * The streams of what changed of people's lists, see me/events.ts: where it is there, pages hear
   * of it at once (`GET /api/me/events`). Something has to listen to the database for it
   * (`listenForPeople`). None unless said.
   */
  readonly events?: PersonEvents | undefined;
  /** Whether migrations and the job queue are in place. */
  ready(): boolean;
  /** Accounts, when people can sign in: see auth/setup.ts. Only asked once `ready`. */
  accounts?(): Accounts | undefined;
  /** Where people install the GitHub App. */
  installUrl?(): string | undefined;
  /** What webhooks say about accounts and installations. Only told once `ready`. */
  readonly onGitHubEvent?: GitHubEventHandler | undefined;
  /** Projects kept in step with editors, see sync/hub.ts. Only asked once `ready`. */
  sync?(): SyncHub | undefined;
  /** The database, for what reads it directly. Only asked once `ready`. */
  db?(): Db | undefined;
  /** Saving projects to GitHub, see archive/. Only asked once `ready`. */
  repositories?(): RepositoryService | undefined;
  /** Files of assets on their way into Git LFS, see lfs/. Only asked once `ready`. */
  lfs?(): LfsUploads | undefined;
  /** Files of assets out of Git LFS, see lfs/downloads.ts. Only asked once `ready`. */
  lfsDownloads?(): LfsDownloads | undefined;
  /** The pictures of conversations, see me/chat-images.ts. Only asked once `ready`. */
  chatImages?(): ChatImages | undefined;
  /**
   * Has the worker make the working copy of a project again from its repository, see
   * archive/rebuild.ts. Undefined where nothing does.
   */
  readonly rebuild?: ((projectId: string) => Promise<void>) | undefined;
  /** What admins set while the platform runs, see settings.ts. Only asked once `ready`. */
  settings?(): Settings | undefined;
  /**
   * The way from the editor's site into a site of its own that takes the sign-in of this one, as
   * the admin site of the platform, see auth/routes.ts. None unless said.
   */
  readonly handoff?: AdminHandoff | undefined;
  /** What also hears each delivery of GitHub's webhooks, as it came, see github/webhook.ts. */
  readonly onGitHubDelivery?:
    ((event: string | undefined, delivery: string | undefined, body: Buffer) => void) | undefined;
  /**
   * Adds what a deployment has besides, as routes and hooks of its own (the admin site, runners of
   * cloud AI on the platform), before the routes of the server. With what it may need of them.
   */
  readonly extend?: ((app: FastifyInstance, parts: ServerParts) => void) | undefined;
  /**
   * Who may do what with which project, see access.ts: only the owner unless said. The hub and the
   * service of repositories are to be given the same.
   */
  readonly access?: AccessPolicy | undefined;
  /**
   * Prefixes under /api whose routes a deployment answers for itself, with why they have nothing of
   * the policy of access, such as the admin site: every other route says what it has (access.ts).
   */
  readonly ownAccess?: readonly { readonly prefix: string; readonly why: string }[] | undefined;
  /** How much each person may have, see limits.ts: nothing is limited unless said. */
  readonly limits?: PersonLimits | undefined;
  /** Only tests: the time of the routes' limits, and of what they say. */
  readonly now?: () => number;
  /** Only tests: where the open catalog of models is taken from, see ai/catalog.ts. */
  readonly modelCatalog?: { readonly fetch: typeof fetch };
  /** The relay of AI services: what counts it (none unless said); for tests, names and connections. */
  readonly relay?: {
    readonly network?: RelayNetwork;
    readonly usage?: () => RelayUsage | undefined;
    readonly limits?: Partial<RelayLimits>;
    /** The networks of this machine, which the relay does not go to. Found out unless given. */
    readonly interfaces?: readonly string[];
  };
}

/** What `Platform.extend` is given of the server. */
export interface ServerParts {
  /** Accounts, once there are, see auth/setup.ts. */
  readonly accounts: () => Accounts | undefined;
  /** The hub, once the database is ready. */
  readonly sync: () => SyncHub | undefined;
  /** The database, once it is ready. */
  readonly db: () => Db | undefined;
  /** What goes through the relay of AI services now, which can be cut for a person. */
  readonly relaying: RelayExchanges;
  /** Which peers say where a request comes from, see proxies.ts. */
  readonly proxies: TrustedProxies;
}

/** The name of a site, as DNS has it. */
const hostnameOf = (origin: string) => new URL(origin).hostname.replace(/^\[(.*)\]$/, "$1");

/** The address of an object of the large file storage, up to its oid. */
const LFS_OBJECT_PATH = /^(\/api\/projects\/[^/]+\/lfs\/objects\/).+$/;

/**
 * A request as the log sees it. The query is left out: a sign-in comes back from GitHub with its code
 * and state in there.
 */
export const logged = (request: Pick<FastifyRequest, "method" | "url" | "host" | "ip">) => ({
  method: request.method,
  url: request.url.startsWith(RELAY_PATH)
    ? // Where a request of the relay goes is nobody's business, see relay/routes.ts.
      RELAY_PATH
    : // Nor which file of the large file storage is downloaded, see lfs/download-routes.ts.
      request.url.replace(/\?.*$/, "").replace(LFS_OBJECT_PATH, "$1…"),
  host: request.host,
  remoteAddress: request.ip,
});

/**
 * The HTTP side. Everything is under /api, which the gateway sends here on editor.example.com,
 * except /api/diagnostics: that one goes to the report service, so nothing here may use it. What a
 * deployment has besides (such as an admin site of its own) comes in by `extend`.
 */
export const buildApp = (
  config: Config,
  platform: Platform,
  logger: FastifyServerOptions["logger"] = { level: config.logLevel },
) => {
  // The gateway puts the address of the browser in X-Forwarded-For, in place of whatever the browser
  // sent. Only the gateway: anyone else who reaches the API is who they are. Limits count by it.
  let warn: (message: string) => void = () => {};
  const proxies = trustedProxies(config.trustedProxies, { warn: (message) => warn(message) });
  const app = Fastify({
    logger:
      typeof logger === "object" && logger !== null
        ? { ...logger, serializers: { req: logged, ...logger.serializers } }
        : logger,
    // The gateway gives up on a request after its own limits; this is for whatever gets past it.
    requestTimeout: 60_000,
    trustProxy: (address: string, hop: number) => hop === 0 && proxies.trusts(address),
  });
  warn = (message) => app.log.warn(message);
  app.addHook("onClose", async () => proxies.stop());

  // What goes wrong inside stays inside: a failed query says the query and what went into it, and
  // the browser gets to know only that it failed. What the request got wrong it is told.
  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: describeError(error) }, "failed");
      return reply.code(status).send({ error: "internal" });
    }
    return reply.code(status).send({
      error: STATUS_CODES[status] ?? "Bad Request",
      message: (error as Error).message,
    });
  });

  // Answers of an API are about now: no cache keeps them, the gateway's included. Unless a route
  // says how its answer may be kept, as a cover does: only by the browser, which asks each time.
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.hasHeader("cache-control")) reply.header("Cache-Control", "no-store");
  });

  const access = platform.access ?? OWNER_ONLY;
  /**
   * What goes by the policy of access goes by this one: the hub and the service of repositories
   * that come with another are a mistake of the deployment, which is said, not gone on with.
   */
  const same = <T extends { readonly access: AccessPolicy }>(part: T | undefined, what: string) => {
    if (part && part.access !== access)
      throw new Error(
        `${what} goes by another policy of access than the server: give both the same`,
      );
    return part;
  };
  const accounts = () => (platform.ready() ? platform.accounts?.() : undefined);
  const sync = () => same(platform.ready() ? platform.sync?.() : undefined, "the hub");
  const db = () => (platform.ready() ? platform.db?.() : undefined);
  /** What goes through the relay of AI services now, which ends with the sessions it came from. */
  const relaying = new RelayExchanges();
  /** The check of every route that names a project, see access.ts. */
  const gate = accessGate(access, db);
  // A route that says nothing of access stops the server here, as it is registered.
  checkDeclared(app, () => platform.ownAccess ?? []);
  // What the deployment adds, before the routes of the server, so that its hooks are on them too.
  platform.extend?.(app, { accounts, sync, db, relaying, proxies });

  app.get(
    "/api/health",
    { config: { access: { none: "whether the server is up" } } },
    async (_request, reply) => {
      const ok = platform.ready() && (await platform.checkDatabase());
      return reply
        .code(ok ? 200 : 503)
        .send({ status: ok ? "ok" : "unavailable", version: config.version });
    },
  );

  app.register(authRoutes, {
    origin: config.publicOrigin,
    accounts,
    installUrl: () => platform.installUrl?.(),
    // What a session opened for syncing, or has going through the relay, ends with it.
    signedOut: (session) => {
      sync()?.closeSession(session);
      relaying.closeSession(session);
    },
    admin: platform.handoff,
    savesTo: () => (platform.ready() ? (platform.repositories?.()?.savesTo ?? "none") : "github"),
  });

  // Syncing projects.
  syncSocket(app, { origin: config.publicOrigin, accounts, hub: sync, proxies });
  const repositories = () =>
    same(platform.ready() ? platform.repositories?.() : undefined, "the service of repositories");
  // The list of a person's projects, and taking one away.
  app.register(projectRoutes, {
    origin: config.publicOrigin,
    accounts,
    db,
    hub: sync,
    webUrl: config.github.webUrl,
    ...(platform.switches && { deletesFrom: platform.switches.deletesFrom }),
    // Repositories nobody looked at for a day, where projects are saved to GitHub at all.
    lookAgain: async (projects) => repositories()?.lookAgain(projects),
    rebuild: platform.rebuild,
    now: platform.now,
    access,
    gate,
  });
  // What goes with the account: AI settings, keys and conversations.
  app.register(meRoutes, {
    origin: config.publicOrigin,
    accounts,
    db,
    sealer: config.masterKeys ? createSealer(config.masterKeys) : undefined,
    now: platform.now,
    libraryMode: () => libraryMode(config.library),
    chatImages: () => (platform.ready() ? platform.chatImages?.() : undefined),
    oldestEditor: platform.switches?.oldestEditor,
    limits: platform.limits,
    access,
    gate,
  });
  // What changed of people's lists, at once.
  if (platform.events)
    app.register(personEventsRoutes, {
      events: platform.events,
      accounts,
      db,
      gate,
      now: platform.now,
    });
  // The open catalog of models for the settings.
  app.register(catalogRoutes, {
    accounts,
    catalog: new ModelCatalogCache(platform.modelCatalog ?? {}),
    now: platform.now,
  });
  // Saving projects to GitHub.
  app.register(repositoryRoutes, {
    origin: config.publicOrigin,
    accounts,
    repositories,
    gate,
  });
  // Files of assets into Git LFS through the platform, 3.2.3 there.
  app.register(lfsRoutes, {
    origin: config.publicOrigin,
    accounts,
    uploads: () => (platform.ready() ? platform.lfs?.() : undefined),
    gate,
  });
  // And out of it.
  app.register(lfsDownloadRoutes, {
    origin: config.publicOrigin,
    accounts,
    downloads: () => (platform.ready() ? platform.lfsDownloads?.() : undefined),
    gate,
  });

  // The relay of AI services for the browser agent. LLM_RELAY=off is off whatever the setting says;
  // the setting is what admins change while it runs.
  app.register(relayRoutes, {
    origin: config.publicOrigin,
    enabled: async () => {
      if (!config.relay.enabled) return false;
      const settings = platform.ready() ? platform.settings?.() : undefined;
      return settings ? (await settings.get(RELAY_SETTING)).enabled : true;
    },
    exchanges: relaying,
    accounts,
    usage: platform.relay?.usage ?? (() => undefined),
    own: {
      names: [hostnameOf(config.publicOrigin)],
      networks: [...config.relay.deny, ...(platform.relay?.interfaces ?? interfaceNetworks())],
    },
    network: platform.relay?.network,
    limits: platform.relay?.limits,
  });

  const { onGitHubEvent } = platform;
  app.register(webhookRoutes, {
    secret: config.github.webhookSecret,
    onEvent:
      onGitHubEvent &&
      (async (event, payload, delivery) => {
        // Not taken in yet: GitHub shows the delivery as failed, and it can be sent again.
        if (!platform.ready()) throw new Error("the database is not ready");
        await onGitHubEvent(event, payload, delivery);
      }),
    onDelivery: platform.onGitHubDelivery,
  });

  return app;
};
