import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerParts } from "../app.ts";
import { SESSION_MS } from "../auth/accounts.ts";
import { fromThisSite } from "../auth/guard.ts";
import { bindingOf } from "../auth/local-credentials.ts";
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
 *   `POST open` (a new token, for `npx animaquill open`). Never for a browser: any request with an
 *   `Origin` is refused, whatever else it has.
 */

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
      async () => ({ url: `${editor}/#aq-token=${tokens.issue()}` }),
    );
  };
