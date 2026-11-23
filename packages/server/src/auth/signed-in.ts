import type { FastifyReply, FastifyRequest } from "fastify";
import type { AccessGate } from "../access.ts";
import type { Accounts, SignedIn } from "./accounts.ts";
import { ourValue, readCookies, SESSION_COOKIE } from "./cookies.ts";
import { clientOf, type Limits } from "./limits.ts";
import { hashOf } from "../seal.ts";

/**
 * Who is signed in, for a route of the editor, after the limit of its kind of request; undefined
 * once answered: 401 `signedOut`, 429 `busy` with Retry-After, 503 `unavailable` while nobody can
 * sign in or the database is not there yet. With a `gate`, then the check of a route that names a
 * project (access.ts): 404 `notFound` for one the person may not do that with.
 */
export const signedInWith =
  (accounts: () => Accounts | undefined, ready: () => boolean, gate?: AccessGate) =>
  async (
    request: FastifyRequest,
    reply: FastifyReply,
    limit: Limits,
  ): Promise<SignedIn | undefined> => {
    const session = ourValue(readCookies(request.headers.cookie)[SESSION_COOKIE]);
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
    const work = accounts();
    if (!work || !ready()) {
      await reply.code(503).send({ error: "unavailable" });
      return undefined;
    }
    const user = await work.session(session);
    if (!user) {
      await reply.code(401).send({ error: "signedOut" });
      return undefined;
    }
    if (gate && !(await gate(request, reply, user.userId))) return undefined;
    return user;
  };
