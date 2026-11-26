import type { AccessGate } from "../access.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Accounts, SignedIn } from "../auth/accounts.ts";
import { fromThisSite, REQUEST_HEADER } from "../auth/guard.ts";
import { clientOf, Limits } from "../auth/limits.ts";
import { describeError } from "../database.ts";
import { hashOf } from "../seal.ts";
import { DownloadRefused, LOOKUP_MOST, rangeOf, type LfsDownloads } from "./downloads.ts";
import type { SessionCredentials } from "../auth/credentials.ts";

/**
 * Files of assets out of the large file storage of a project's repository, for the editor, see
 * `LfsAccess.lookup` and `LfsAccess.piece` of its host:
 *
 * - `POST /api/projects/:id/lfs/lookup` with `{objects: [{oid, size}]}`, 100 at most: `{objects}`,
 *   each `{oid, state}`: ready, uploading (with `received` and `size`), missing, changed,
 *   unavailable.
 * - `GET /api/projects/:id/lfs/objects/:oid?size=<bytes>` with `Range: bytes=<from>-[<to>]`: 206
 *   with that part of the object, 64 MiB of it at most, and `Content-Range`. Only from pages of this
 *   site (`X-AnimaQuill: 1`, and `Sec-Fetch-Site` same-origin where the browser says it), so that a
 *   link elsewhere spends nobody's traffic.
 *
 * Errors are `{error: <code>}`: notFound, notLinked, gone, githubQuota, missing (410), changed,
 * busy (with Retry-After; `detail: "daily"` once the person had what a day gives), invalid,
 * unavailable, signedOut, forbidden. What answers carry of the object is its bytes and nothing else
 * the storage said.
 */

export interface DownloadRoutesOptions {
  /** The check of the routes that name a project, see access.ts. */
  readonly gate: AccessGate;
  readonly origin: string;
  readonly accounts: () => Accounts | undefined;
  /** How the browser shows its session, see auth/credentials.ts. */
  readonly credentials: SessionCredentials;
  /** Undefined where there are no downloads: no GitHub App. */
  readonly downloads: () => LfsDownloads | undefined;
  readonly now?: () => number;
}

type Params = { readonly id: string };
type ObjectParams = { readonly id: string; readonly oid: string };

const TEN_MINUTES = 10 * 60_000;
const OID = /^[0-9a-f]{64}$/;
const SIZE = /^(?:0|[1-9][0-9]{0,15})$/;

/** Whether a request comes from a page of this site, for one that changes nothing. */
const fromHere = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const site = request.headers["sec-fetch-site"];
  if (request.headers[REQUEST_HEADER] !== "1" || (site !== undefined && site !== "same-origin"))
    await reply.code(403).send({ error: "forbidden" });
};

export const lfsDownloadRoutes = async (app: FastifyInstance, options: DownloadRoutesOptions) => {
  const now = options.now ?? Date.now;
  const guard = fromThisSite(options.origin);
  const limits = {
    lookup: new Limits({ perClient: 1200, perOwn: 600, ceiling: 12_000 }, TEN_MINUTES, now),
    piece: new Limits({ perClient: 3000, perOwn: 3000, ceiling: 30_000 }, TEN_MINUTES, now),
  };

  app.setErrorHandler((error, request, reply) => {
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: describeError(error) }, "failed");
      return reply.code(503).send({ error: "unavailable" });
    }
    return reply.code(status).send({ error: "invalid" });
  });

  // A lookup of 100 objects is some 9 KB.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 16 * 1024 },
    (_request, body, done) => {
      if (typeof body !== "string" || body.trim() === "") return done(null, undefined);
      try {
        done(null, JSON.parse(body));
      } catch {
        done(Object.assign(new Error("the body is not JSON"), { statusCode: 400 }), undefined);
      }
    },
  );

  /** Who is signed in, after the limit of this kind of request; undefined once answered. */
  const signedIn = async (
    request: FastifyRequest,
    reply: FastifyReply,
    limit: Limits,
  ): Promise<{ user: SignedIn; work: LfsDownloads } | undefined> => {
    const session = options.credentials.sessionOf(request);
    if (!session) {
      await reply.code(401).send({ error: "signedOut" });
      return undefined;
    }
    const own = hashOf(session).toString("base64url").slice(0, 22);
    if (!limit.take(clientOf(request.ip), own)) {
      await reply
        .code(429)
        .header("retry-after", String(limit.retryAfter(clientOf(request.ip), own)))
        .send({ error: "busy" });
      return undefined;
    }
    const people = options.accounts();
    const work = options.downloads();
    if (!people || !work) {
      await reply.code(503).send({ error: "unavailable" });
      return undefined;
    }
    const user = await people.session(session);
    if (!user) {
      await reply.code(401).send({ error: "signedOut" });
      return undefined;
    }
    if (!(await options.gate(request, reply, user.userId))) return undefined;
    return { user, work };
  };

  const refused = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof DownloadRefused)) throw error;
    if (error.retryAfter !== undefined) reply.header("retry-after", String(error.retryAfter));
    return reply.code(error.status).send({
      error: error.code,
      ...(error.detail !== undefined && { detail: error.detail }),
    });
  };

  app.post<{ Params: Params; Body: unknown }>(
    "/api/projects/:id/lfs/lookup",
    { config: { access: { project: "id", action: "read" } }, preHandler: guard },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.lookup);
      if (!who) return reply;
      const objects = (request.body as { objects?: unknown } | undefined)?.objects;
      if (!Array.isArray(objects) || objects.length > LOOKUP_MOST)
        return reply.code(400).send({ error: "invalid" });
      const asked: { oid: string; size: number }[] = [];
      for (const each of objects as { oid?: unknown; size?: unknown }[]) {
        const { oid, size } = each ?? {};
        if (
          typeof oid !== "string" ||
          !OID.test(oid) ||
          typeof size !== "number" ||
          !Number.isSafeInteger(size) ||
          size < 0
        )
          return reply.code(400).send({ error: "invalid" });
        asked.push({ oid, size });
      }
      try {
        return {
          objects: await who.work.lookup(who.user, request.params.id, asked),
        };
      } catch (error) {
        return refused(reply, error);
      }
    },
  );

  app.get<{ Params: ObjectParams; Querystring: { size?: string } }>(
    "/api/projects/:id/lfs/objects/:oid",
    // A HEAD would fetch from the storage what nobody reads.
    {
      config: { access: { project: "id", action: "read" } },
      preHandler: fromHere,
      exposeHeadRoute: false,
    },
    async (request, reply) => {
      const who = await signedIn(request, reply, limits.piece);
      if (!who) return reply;
      const { oid } = request.params;
      const sizeText = request.query.size;
      if (!OID.test(oid) || typeof sizeText !== "string" || !SIZE.test(sizeText))
        return reply.code(400).send({ error: "invalid" });
      const size = Number(sizeText);
      const header = request.headers.range;
      const range = rangeOf(typeof header === "string" ? header : undefined, size);
      if (!range)
        return reply
          .code(416)
          .header("content-range", `bytes */${size}`)
          .send({ error: "invalid" });
      try {
        const piece = await who.work.piece(who.user, request.params.id, { oid, size }, range);
        // Gone while the storage was asked: nobody to answer.
        reply.raw.once("close", () => piece.body.destroy());
        return reply
          .code(206)
          .header("content-type", "application/octet-stream")
          .header("content-range", `bytes ${piece.start}-${piece.end}/${piece.size}`)
          .header("content-length", String(piece.end - piece.start + 1))
          .header("accept-ranges", "bytes")
          .header("content-disposition", "attachment")
          .header("content-security-policy", "sandbox; default-src 'none'")
          .header("cross-origin-resource-policy", "same-origin")
          .header("cache-control", "no-store, no-transform")
          .send(piece.body);
      } catch (error) {
        return refused(reply, error);
      }
    },
  );
};
