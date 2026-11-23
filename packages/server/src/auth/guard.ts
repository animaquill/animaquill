import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Every request that changes something, such as signing out, has to come from a page of this site.
 * Two checks, each enough on its own in today's browsers:
 *
 * - `Origin` has to be this site. Browsers send it with every POST, and a page elsewhere cannot
 *   change it. (Our pages send `Referrer-Policy: no-referrer`, under which a form would send
 *   `Origin: null`; `fetch` sends the real one.)
 * - A header of our own has to be there. A page elsewhere can only send that after asking first
 *   (CORS), and this API never answers that question.
 *
 * The session cookie is SameSite=Lax on top of that.
 */
export const REQUEST_HEADER = "x-animaquill";

export const fromThisSite =
  (origin: string) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.headers.origin !== origin || request.headers[REQUEST_HEADER] !== "1") {
      request.log.warn(
        { origin: request.headers.origin ?? null, header: REQUEST_HEADER in request.headers },
        "a request from somewhere else, turned away",
      );
      await reply.code(403).send({ error: "forbidden" });
    }
  };
