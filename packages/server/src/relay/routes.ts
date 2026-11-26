import type { ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline, Transform } from "node:stream";
import { relayRefusalBody, type RelayRefusal } from "@animaquill/host/relay";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Accounts } from "../auth/accounts.ts";
import { REQUEST_HEADER } from "../auth/guard.ts";
import { clientOf, Limits } from "../auth/limits.ts";
import { whenSignedOutEverywhere } from "../auth/tokens.ts";
import { describeError } from "../database.ts";
import { hashOf } from "../seal.ts";
import { RelayExchanges } from "./exchanges.ts";
import { RELAY_LIMITS, RelayGate, type Pass, type RelayLimits } from "./gate.ts";
import { ANSWER_POLICY, answerHeadersOf, requestHeadersFor } from "./headers.ts";
import {
  OwnAddresses,
  RelayRefused,
  relayAgent,
  systemNetwork,
  type RelayNetwork,
} from "./network.ts";
import { RELAY_PATH, targetOf, type Target } from "./target.ts";
import type { RelayUsage } from "./use.ts";
import type { SessionCredentials } from "../auth/credentials.ts";

/**
 * The relay of AI services: `/api/llm-relay/https/<name>/<path>` takes a request of the browser
 * agent and passes it on to `https://<name>/<path>`, for services that do not let a page read their
 * answers (no CORS). The answer streams back as it comes, and a request the browser stops is
 * stopped at the service too, at once.
 *
 * - Only for people signed in, from the editor's pages: the session cookie, the Origin of this
 *   site, and the header of this site (see auth/guard.ts). Disabling someone, or signing them or a
 *   browser out, ends what they have going through it at once (exchanges.ts).
 * - Only https, only port 443, only a name on the internet, and only to addresses on the internet
 *   that are not the platform's own (addresses.ts), looked up once and connected to as found
 *   (network.ts). A name that points anywhere else is answered as one that is not there at all,
 *   so that nobody learns through it what names there are inside. Redirects are not followed.
 * - Nothing of this site goes on: not its cookies, not its headers. Only what the libraries of
 *   services send, such as the key of the service. What comes back is something for the page to
 *   read, never a page of this site (headers.ts).
 * - Nothing is kept or logged of what goes through, nor where it goes (the user's decision of
 *   2026-11-09, "只转发不保存不记录"): whoever runs the server may count requests and bytes of each
 *   person (`RelayUsage`, use.ts), and the log says why a request failed, without where it went.
 * - Limited in size, time, how often and how many at once (gate.ts).
 * - Off with LLM_RELAY=off, whatever the settings say, and off with the setting `relay` that admins
 *   change (settings.ts), within the ten seconds settings are kept; what goes through then stops
 *   at its next look (`offCheckMs`).
 */

export interface RelayRoutesOptions {
  /** This site, which requests have to come from. */
  readonly origin: string;
  /** Whether the relay is on now. */
  readonly enabled: () => boolean | Promise<boolean>;
  /** Undefined while nobody can sign in, or the database is not there yet. */
  readonly accounts: () => Accounts | undefined;
  /** How the browser shows its session, see auth/credentials.ts. */
  readonly credentials: SessionCredentials;
  /** Where use is counted, once the database is there. */
  readonly usage: () => RelayUsage | undefined;
  /** The platform's own names and networks, which the relay never goes to, see `OwnAddresses`. */
  readonly own: { readonly names: readonly string[]; readonly networks: readonly string[] };
  /** What goes through now, for whoever ends it from outside, such as disabling someone. */
  readonly exchanges?: RelayExchanges | undefined;
  /** Only tests: names and connections of their own. */
  readonly network?: RelayNetwork | undefined;
  readonly limits?: Partial<RelayLimits> | undefined;
  readonly now?: () => number;
}

/** Answers in place of the service, saying why, in a way the editor tells from the service. */
const refuse = (
  reply: FastifyReply,
  status: number,
  why: RelayRefusal,
  details: string,
  retryAfter?: number,
) => {
  if (retryAfter !== undefined) reply.header("retry-after", String(retryAfter));
  return reply.code(status).send(relayRefusalBody(why, details));
};

/**
 * Whether a request comes from a page of this site, as auth/guard.ts has it: the header of this
 * site, and the Origin of this site. Browsers leave Origin out of a GET to their own site, which is
 * how the editor asks a service for its models: the header is enough on its own there, as only a
 * page of this site can send it, since the API never answers the question that a page elsewhere has
 * to ask first.
 */
const fromThePage = (request: FastifyRequest, origin: string): boolean => {
  if (request.headers[REQUEST_HEADER] !== "1") return false;
  const from = request.headers.origin;
  if (from !== undefined) return from === origin;
  const site = request.headers["sec-fetch-site"];
  return request.method === "GET" && (site === undefined || site === "same-origin");
};

/** Whether the browser went: nothing it asked for is worth doing any more. */
const gone = (request: FastifyRequest, reply: FastifyReply) =>
  reply.raw.destroyed || request.raw.socket?.destroyed === true;

/** The length a request says it has, when it says one. */
const declaredLength = (value: string | undefined): number | undefined =>
  value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : undefined;

/**
 * Why a connection to a service failed, for people, without any of its addresses. A name that is
 * not there, and a name that points where the relay does not go, are answered in the same words.
 */
const failureOf = (
  error: NodeJS.ErrnoException,
  hostname: string,
): [status: number, why: RelayRefusal, details: string] => {
  const code = error instanceof RelayRefused ? error.why : String(error.code ?? "");
  if (code === "blocked" || code === "ENOTFOUND" || code === "ENODATA" || code.startsWith("EAI_"))
    return [
      502,
      "unreachable",
      `${hostname} has no address on the internet that the relay goes to`,
    ];
  if (code === "EBUSY")
    return [503, "busy", "the relay is looking up too many names, try again soon"];
  if (code === "ETIMEOUT") return [504, "timeout", `looking ${hostname} up took too long`];
  if (/CERT|SELF_SIGNED|UNABLE_TO_|ERR_TLS|ERR_SSL/.test(code))
    return [502, "unreachable", `the certificate of ${hostname} is not right (${code})`];
  if (code === "ETIMEDOUT") return [504, "timeout", `${hostname} did not answer`];
  return [502, "unreachable", `${hostname} could not be reached (${code || "no connection"})`];
};

/** Where a redirect goes, without its query, which could carry anything. */
const placeOf = (location: string | undefined): string | undefined => {
  if (!location) return undefined;
  return location.replace(/[?#].*$/, "").slice(0, 200);
};

export const relayRoutes = async (app: FastifyInstance, options: RelayRoutesOptions) => {
  const limits: RelayLimits = { ...RELAY_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const network = options.network ?? systemNetwork;
  const gate = new RelayGate(limits, now);
  const exchanges = options.exchanges ?? new RelayExchanges();
  /**
   * Requests before anyone is known, by address where it says who that is and otherwise by session:
   * against floods, before the database is asked who it is. Looser than what each person gets
   * (`RelayGate`), as several people can be behind one address, and all IPv6 visitors behind the
   * Docker bridge for now (auth/limits.ts).
   */
  const entries = new Limits({ perClient: 6000, perOwn: 1200, ceiling: 60_000 }, 10 * 60_000, now);
  const own = new OwnAddresses({
    names: options.own.names,
    networks: options.own.networks,
    resolve: (name) => network.resolve(name),
    warn: (message) => app.log.warn(message),
  });
  const agent = relayAgent(network, () => own.networks, {
    sockets: limits.concurrent,
    keepMs: limits.keepMs,
  });
  // Signed out everywhere, as after taking the App's authorization back on GitHub.
  const stopListening = whenSignedOutEverywhere((userId) => exchanges.closeUser(userId));
  // Turned off while answers stream: they end too, at the next look, not an hour later.
  const watching = setInterval(() => {
    if (exchanges.size === 0) return;
    void isOn().then((on) => {
      if (!on) exchanges.closeAll("off");
    });
  }, limits.offCheckMs);
  watching.unref?.();
  // An answer can stream for an hour: when the API stops, as with every release, they stop first,
  // and the browser shows them cut short, rather than holding up the rest until it is killed.
  app.addHook("preClose", async () => {
    clearInterval(watching);
    stopListening();
    own.stop();
    agent.destroy();
  });

  // Bodies go on as they come: nothing here reads them.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, _payload, done) => done(null, undefined));
  // Every answer of the relay is something for the page to read, see headers.ts.
  app.addHook("onSend", async (_request, reply) => {
    reply.headers(ANSWER_POLICY);
  });

  /** A request that failed, in the log: why, never where it went or what was in it. */
  const logFailure = (why: string, code?: string) =>
    app.log.warn(
      { relay: { end: why, ...(code && { code }) } },
      "a request through the relay failed",
    );

  /** Passes a request on, once it may go. Resolves once the browser has the head of an answer. */
  const pass = (
    request: FastifyRequest,
    reply: FastifyReply,
    target: Target,
    length: number | undefined,
    who: { readonly userId: string; readonly session: string },
    entry: Pass,
  ) =>
    new Promise<FastifyReply>((resolve) => {
      const started = now();
      const method = request.method;
      const body = request.raw;
      let sent = 0;
      let received = 0;
      /** How it ended, once it did. */
      let ended: string | undefined;
      /** Whether the browser has the head of an answer, the service's or the relay's. */
      let answered = false;
      let meter: Transform | undefined;
      let upstream: ClientRequest | undefined;
      const timers: ReturnType<typeof setTimeout>[] = [];

      /** Counts a request once, however it ends, and lets go of its place. */
      const settle = (how: string, code?: string): boolean => {
        if (ended !== undefined) return false;
        ended = how;
        for (const timer of timers) clearTimeout(timer);
        forget();
        entry.bytes(sent + received);
        entry.leave();
        if (!["done", "stopped", "signedOut", "off"].includes(how)) logFailure(how, code);
        options
          .usage()
          ?.record({ userId: who.userId, at: new Date(started), sent, received })
          .catch((error: unknown) =>
            app.log.warn({ err: describeError(error) }, "the use of the relay was not counted"),
          );
        return true;
      };

      /** The service and the browser go their ways: what is left of the body is read and dropped. */
      const letGo = () => {
        upstream?.destroy();
        body.unpipe();
        body.resume();
      };

      /**
       * Before the answer began, the browser hears from the relay why it ended; after, the answer
       * stops short, as when the connection breaks.
       */
      const fail = (status: number, why: RelayRefusal, details: string, code?: string) => {
        if (!settle(why, code)) return;
        letGo();
        if (!answered) {
          answered = true;
          resolve(refuse(reply, status, why, details));
        } else meter?.destroy(new Error(`the relay ended the answer: ${why}`));
      };

      /** The browser stopped, or went: the service stops too, now, and nothing more is sent. */
      const stopped = () => {
        if (settle("stopped")) letGo();
        meter?.destroy();
        if (!answered) {
          answered = true;
          resolve(reply.hijack());
        }
      };

      // First of all, so that a browser that goes at any moment from here on is heard.
      const forget = exchanges.add(who.userId, who.session, (why) =>
        why === "off"
          ? fail(503, "off", "the relay was turned off while the request was on its way")
          : fail(401, "signedOut", "signed out while the request was on its way"),
      );
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) stopped();
      });
      // What the browser did not finish sending: it went, or broke off.
      body.on("aborted", stopped);
      body.on("error", stopped);
      if (gone(request, reply)) {
        stopped();
        return;
      }

      try {
        upstream = httpsRequest({
          agent,
          host: target.hostname,
          servername: target.hostname,
          port: network.port ?? 443,
          method,
          path: target.path,
          headers: {
            ...requestHeadersFor(request.headers, target.hostname),
            ...(length !== undefined && { "content-length": String(length) }),
          },
          setHost: false,
        });
      } catch {
        // What Node does not send, such as a character a path cannot have.
        fail(400, "badTarget", "the relay cannot send this request");
        return;
      }
      const sending = upstream;

      const connecting = setTimeout(
        () => fail(504, "timeout", `${target.hostname} could not be reached in time`),
        limits.connectMs,
      );
      const idle = setTimeout(
        () => fail(504, "timeout", `nothing came either way for ${limits.idleMs / 1000} s`),
        limits.idleMs,
      );
      const total = setTimeout(
        () => fail(504, "timeout", `it took longer than ${limits.totalMs / 1000} s`),
        limits.totalMs,
      );
      timers.push(connecting, idle, total);
      const touch = () => idle.refresh();

      sending.on("socket", (socket) => {
        if (sending.reusedSocket) clearTimeout(connecting);
        else socket.once("secureConnect", () => clearTimeout(connecting));
      });
      sending.on("error", (error: NodeJS.ErrnoException) => {
        if (ended !== undefined) return;
        const [status, why, details] = failureOf(error, target.hostname);
        const code = error instanceof RelayRefused ? error.why : error.code;
        fail(status, why, details, typeof code === "string" ? code : undefined);
      });

      sending.on("response", (answer) => {
        if (ended !== undefined) {
          answer.destroy();
          return;
        }
        // Whatever goes wrong with an answer stays with this request: nothing else may go with it.
        try {
          touch();
          const status = answer.statusCode ?? 0;
          // A redirect is not followed, and not passed on either: the browser would follow it, with
          // this site's cookies where it points here. The same for what only a proxy says.
          if ((status >= 300 && status < 400) || status === 407) {
            const place = placeOf(answer.headers.location);
            answer.destroy();
            fail(
              502,
              "redirect",
              place
                ? `the service sent the request to ${place}, which the relay does not follow`
                : `the service answered ${status}, which the relay does not pass on`,
            );
            return;
          }
          // What is not a status of HTTP is no answer at all.
          if (status < 200 || status > 599) {
            answer.destroy();
            fail(
              502,
              "failed",
              `the service answered ${status}, which HTTP does not have`,
              "status",
            );
            return;
          }
          // The service went before the answer was over: the browser's stops short.
          const broken = () => {
            if (settle("broken")) letGo();
          };
          answer.once("aborted", broken);
          answer.once("error", broken);
          const counted = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              received += chunk.length;
              if (received > limits.answerBytes) {
                if (settle("tooLarge")) letGo();
                done(new Error("the answer is longer than the relay takes"));
                return;
              }
              touch();
              done(null, chunk);
            },
          });
          meter = counted;
          pipeline(answer, counted, (error) => {
            if (error && settle("broken")) letGo();
          });
          reply.raw.once("finish", () => settle("done"));
          reply.code(status).headers(answerHeadersOf(answer.headers));
          answered = true;
          resolve(reply.send(counted));
        } catch (error) {
          answer.destroy();
          const code = (error as NodeJS.ErrnoException).code;
          fail(502, "failed", "the answer of the service could not be passed on", code);
        }
      });

      if (method === "POST") {
        const up = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            sent += chunk.length;
            if (sent > limits.requestBytes) {
              done(
                new RelayRefused(
                  "tooLarge",
                  `requests can have at most ${limits.requestBytes} bytes`,
                ),
              );
              return;
            }
            touch();
            done(null, chunk);
          },
        });
        up.on("error", (error) =>
          fail(413, "tooLarge", error instanceof RelayRefused ? error.message : "too large"),
        );
        body.pipe(up).pipe(sending);
      } else {
        sending.end();
      }
    });

  /** Whether the relay is on now: the configuration, and the setting that admins change. */
  const isOn = async () => {
    try {
      return await options.enabled();
    } catch (error) {
      app.log.warn(
        { err: describeError(error) },
        "whether the relay is on is not known: it is off",
      );
      return false;
    }
  };

  app.route({
    method: ["GET", "POST"],
    url: `${RELAY_PATH}*`,
    config: { access: { none: "passing requests on to AI services, of no project" } },
    exposeHeadRoute: false,
    // Fastify would log every request with its address, which says where it goes, and the end of
    // every answer that stops short. What the relay logs, it logs itself, see `logFailure`.
    logLevel: "error",
    handler: async (request, reply) => {
      if (!(await isOn())) return refuse(reply, 503, "off", "the relay is turned off");
      if (!fromThePage(request, options.origin)) {
        app.log.warn(
          { origin: request.headers.origin ?? null, header: REQUEST_HEADER in request.headers },
          "a request to the relay from somewhere else, turned away",
        );
        return refuse(reply, 403, "forbidden", "only the pages of the editor can use the relay");
      }
      const session = options.credentials.sessionOf(request);
      const mine =
        session === undefined ? undefined : hashOf(session).toString("base64url").slice(0, 22);
      const client = clientOf(request.ip);
      if (!entries.take(client, mine))
        return refuse(
          reply,
          429,
          "busy",
          "too many requests, try again later",
          entries.retryAfter(client, mine),
        );
      if (!session) return refuse(reply, 401, "signedOut", "sign in to use the relay");
      const work = options.accounts();
      if (!work)
        return refuse(reply, 503, "unavailable", "signing in does not work on the platform now");
      const signedIn = await work.session(session);
      if (!signedIn) return refuse(reply, 401, "signedOut", "sign in to use the relay");

      const target = targetOf(request.raw.url ?? "");
      if (!target)
        return refuse(
          reply,
          400,
          "badTarget",
          "the relay takes https://<name>/<path> only, with a name on the internet and no port",
        );
      if (own.isName(target.hostname))
        return refuse(reply, 403, "blocked", `${target.hostname} is the platform itself`);
      const length = declaredLength(request.headers["content-length"]);
      if (request.method === "POST" && length !== undefined && length > limits.requestBytes)
        return refuse(
          reply,
          413,
          "tooLarge",
          `requests can have at most ${limits.requestBytes} bytes`,
        );
      // The platform's own addresses have to be known before anything goes anywhere.
      if (!own.ready) await own.refresh();
      if (!own.ready)
        return refuse(reply, 503, "unavailable", "the relay is not ready yet, try again soon");

      // A browser that went while it was asked who it is takes no place, and goes nowhere.
      if (gone(request, reply)) return reply.hijack();
      const entry = gate.enter(signedIn.userId);
      if (!entry.ok)
        return entry.who === "everyone"
          ? refuse(reply, 503, "busy", "the relay is busy, try again soon", entry.retryAfter)
          : refuse(reply, 429, "busy", "too many requests, try again later", entry.retryAfter);
      return pass(
        request,
        reply,
        target,
        request.method === "POST" ? length : undefined,
        { userId: signedIn.userId, session: hashOf(session).toString("base64url") },
        entry.pass,
      );
    },
  });

  app.route({
    method: ["HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"],
    url: `${RELAY_PATH}*`,
    config: { access: { none: "refused, of no project" } },
    logLevel: "error",
    handler: async (_request, reply) =>
      (await isOn())
        ? refuse(reply, 405, "method", "the relay passes on GET and POST only")
        : refuse(reply, 503, "off", "the relay is turned off"),
  });
};
