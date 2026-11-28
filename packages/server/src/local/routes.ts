import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerParts } from "../app.ts";
import { SESSION_MS } from "../auth/accounts.ts";
import { fromThisSite } from "../auth/guard.ts";
import { bindingOf } from "../auth/local-credentials.ts";
import { Limits } from "../auth/limits.ts";
import { signedInWith } from "../auth/signed-in.ts";
import { describeError } from "../database.ts";
import type { OneTimeTokens } from "./tokens.ts";

/**
 * What the backend of `npx animaquill` answers besides the server (design O4 of AnimaQuill Cloud,
 * sections 2 and 5), as `Platform.extend`:
 *
 * - every request has to be for the editor's site, by its `Host` exactly: 421 otherwise, so that a
 *   name another site leads to this machine (DNS rebinding) reaches nothing here;
 * - `POST /api/local/session`: a one-time token from the address the browser was opened with
 *   (`OneTimeTokens`) for a session of the person of this machine, the cookie, and its key of
 *   binding (auth/local-credentials.ts) in the answer;
 * - `/api/local/admin/`: for the command line of the same user, with the admin key of
 *   `backend.json`, which only that user can read: `GET ping` (which instance this is) and
 *   `POST open` (a new token, for `npx animaquill open`), `POST export` `{dir}` (the data of the
 *   server into a folder, as `npx animaquill server export` asks while it runs). Never for a
 *   browser: any request with an `Origin` is refused, whatever else it has.
 * - `/api/local/server`: how the server of this machine stands, for "设置 › 服务器", to the person
 *   of this machine only (signed in, without an account of GitHub), see `LocalServerHooks`:
 *   `GET` (`LocalServerState`); `POST master-key` (the master key as a file, to save a copy);
 *   `POST master-key/saved` `{fingerprint}` (people said they saved it); `DELETE old/:name` (a
 *   folder of a version of PostgreSQL before). What changes, and the key, only from pages of this
 *   site.
 */

/** How the server of this machine stands, as its settings show it. */
export interface LocalServerState {
  readonly version: string;
  /** The data folder. */
  readonly dataDir: string;
  /** Its own PostgreSQL and its major version, or one people gave (`--database`). */
  readonly database: { readonly kind: "own"; readonly major: number } | { readonly kind: "given" };
  /** The master key, which seals the keys of AI services: undefined where there is none. */
  readonly masterKey?: {
    readonly path: string;
    /** A short digest of it, which says which one it is, never the key. */
    readonly fingerprint: string;
    /** People said they saved a copy of this one. */
    readonly saved: boolean;
    /** It was made as this start began, though the database was there: what was sealed is lost. */
    readonly madeAgain: boolean;
  };
  /** Folders of versions of PostgreSQL before, which an upgrade left. */
  readonly old: readonly {
    readonly name: string;
    readonly major: number;
    readonly bytes: number;
  }[];
  /** The upgrade to a new version of PostgreSQL did not go as this start began: why. */
  readonly upgradeFailed?: { readonly from: number; readonly to: number; readonly reason: string };
}

/** What the routes of the server's state do, given by the backend of `npx animaquill`. */
export interface LocalServerHooks {
  state(): Promise<LocalServerState>;
  /** Notes that people saved the key of this digest: false where it is not the key now. */
  keySaved(fingerprint: string): Promise<boolean>;
  /** The master key as its file has it. */
  masterKey(): Promise<string | undefined>;
  /** Takes a folder of `old` away. */
  removeOld(name: string): Promise<"removed" | "notFound">;
}

export interface LocalRoutesOptions {
  /** The editor's site, such as http://animaquill.localhost:7651. */
  readonly editor: string;
  readonly tokens: OneTimeTokens;
  /** The secret of the keys of binding, see `bindingSecretOf`. */
  readonly bindingSecret: Buffer;
  /** The admin key of this start, as `backend.json` has it. */
  readonly adminKey: string;
  /** The instance of this start, as `backend.json` has it. */
  readonly instance: string;
  readonly version: string;
  /**
   * What `POST /api/local/admin/open` gives the command line: the address with a new token unless
   * said; the backend of `npx animaquill` adds the page in its data folder that leads there, so
   * that the token never goes into a command line (see `open-page.ts` there).
   */
  readonly open?: (() => Promise<{ readonly url: string; readonly page?: string }>) | undefined;
  /** How the server stands, for its settings: none unless said. */
  readonly server?: LocalServerHooks | undefined;
  /**
   * The data of the server into `dir`, for `POST /api/local/admin/export`: what it says, or a
   * `string` that says why not. None unless said.
   */
  readonly exportData?:
    ((dir: string) => Promise<Readonly<Record<string, unknown>> | string>) | undefined;
}

export const ADMIN_PREFIX = "/api/local/admin";

const digest = (text: string) => createHash("sha256").update(text).digest();

export const localRoutes =
  (options: LocalRoutesOptions) =>
  (app: FastifyInstance, parts: ServerParts): void => {
    const { editor, tokens, bindingSecret, version, instance } = options;
    const host = new URL(editor).host;
    const adminKey = digest(`Bearer ${options.adminKey}`);

    app.addHook("onRequest", async (request, reply) => {
      if (request.headers.host !== host) {
        request.log.warn({ host: request.headers.host ?? null }, "a request for another site");
        return reply.code(421).send({ error: "misdirected" });
      }
    });

    /** Only the command line of this user: the admin key, and nothing a browser sends. */
    const admin = async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.headers.origin !== undefined) {
        request.log.warn({}, "the admin of the backend asked from a page, turned away");
        return reply.code(403).send({ error: "forbidden" });
      }
      const given = digest(request.headers.authorization ?? "");
      if (!timingSafeEqual(given, adminKey)) return reply.code(401).send({ error: "unauthorized" });
    };

    app.post<{ Body: { token?: unknown } }>(
      "/api/local/session",
      {
        config: { access: { none: "signing in as the person of this machine" } },
        preHandler: fromThisSite(editor),
        bodyLimit: 1024,
      },
      async (request, reply) => {
        if (!tokens.take(request.body?.token)) return reply.code(401).send({ error: "token" });
        const work = parts.accounts();
        if (!work) return reply.code(503).send({ error: "unavailable" });
        let session: string;
        try {
          session = await work.localSession(request.headers["user-agent"]);
        } catch (error) {
          request.log.error({ err: describeError(error) }, "no session for this machine");
          return reply.code(503).send({ error: "unavailable" });
        }
        return reply
          .header("set-cookie", parts.credentials.setCookie("session", session, SESSION_MS / 1000))
          .send({ binding: bindingOf(bindingSecret, session) });
      },
    );

    app.get(
      `${ADMIN_PREFIX}/ping`,
      { config: { access: { none: "the command line of this machine" } }, onRequest: admin },
      async () => ({ instance, version }),
    );

    app.post(
      `${ADMIN_PREFIX}/open`,
      {
        config: { access: { none: "the command line of this machine" } },
        onRequest: admin,
        bodyLimit: 1024,
      },
      async () => options.open?.() ?? { url: `${editor}/#aq-token=${tokens.issue()}` },
    );

    app.post<{ Body: { dir?: unknown } }>(
      `${ADMIN_PREFIX}/export`,
      {
        config: { access: { none: "the command line of this machine" } },
        onRequest: admin,
        bodyLimit: 8192,
      },
      async (request, reply) => {
        const dir = request.body?.dir;
        if (typeof dir !== "string" || dir === "" || dir.length > 4096 || dir.includes("\0"))
          return reply.code(400).send({ error: "invalid" });
        if (!options.exportData) return reply.code(404).send({ error: "notFound" });
        const done = await options.exportData(dir);
        if (typeof done === "string") return reply.code(409).send({ error: "refused", why: done });
        return done;
      },
    );

    const hooks = options.server;
    if (!hooks) return;
    const signedIn = signedInWith(
      parts.credentials,
      parts.accounts,
      () => parts.db() !== undefined,
    );
    const limit = new Limits({ perClient: 600, perOwn: 300, ceiling: 3000 }, 10 * 60_000);
    /** The person of this machine, and nobody else: undefined once answered. */
    const ofThisMachine = async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await signedIn(request, reply, limit);
      if (!user) return undefined;
      // By who they are, not by whether GitHub is connected: the person of this machine keeps
      // this once their account of GitHub is connected too.
      if (user.kind !== "local") {
        await reply.code(403).send({ error: "forbidden" });
        return undefined;
      }
      return user;
    };
    const route = { config: { access: { none: "the server of this machine" } } } as const;
    const fromHere = { ...route, preHandler: fromThisSite(editor) } as const;

    app.get("/api/local/server", route, async (request, reply) => {
      if (!(await ofThisMachine(request, reply))) return reply;
      reply.header("cache-control", "no-store");
      return hooks.state();
    });

    app.post("/api/local/server/master-key", fromHere, async (request, reply) => {
      if (!(await ofThisMachine(request, reply))) return reply;
      const key = await hooks.masterKey();
      if (key === undefined) return reply.code(404).send({ error: "notFound" });
      request.log.info({}, "the master key was given to the person of this machine to save");
      return reply
        .header("cache-control", "no-store")
        .header("content-type", "text/plain; charset=utf-8")
        .header("x-content-type-options", "nosniff")
        .send(key);
    });

    app.post<{ Body: { fingerprint?: unknown } }>(
      "/api/local/server/master-key/saved",
      { ...fromHere, bodyLimit: 1024 },
      async (request, reply) => {
        if (!(await ofThisMachine(request, reply))) return reply;
        const fingerprint = request.body?.fingerprint;
        if (typeof fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(fingerprint))
          return reply.code(400).send({ error: "invalid" });
        if (!(await hooks.keySaved(fingerprint)))
          return reply.code(409).send({ error: "otherKey" });
        return reply.code(204).send();
      },
    );

    app.delete<{ Params: { name: string } }>(
      "/api/local/server/old/:name",
      fromHere,
      async (request, reply) => {
        if (!(await ofThisMachine(request, reply))) return reply;
        const done = await hooks.removeOld(request.params.name);
        if (done === "notFound") return reply.code(404).send({ error: "notFound" });
        return reply.code(204).send();
      },
    );
  };
