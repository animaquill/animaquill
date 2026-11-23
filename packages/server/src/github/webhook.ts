import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { describeError } from "../database.ts";

/** GitHub sends at most 25 MB, and drops bigger deliveries itself. */
export const WEBHOOK_BODY_LIMIT = 25 * 1024 * 1024;

/**
 * Whether `header` (X-Hub-Signature-256) signs `body` with `secret`: "sha256=" and the hex of the
 * HMAC-SHA256 of the bytes as they came. The comparison takes the same time however much matches.
 */
export const signatureMatches = (
  secret: string,
  body: Buffer,
  header: string | undefined,
): boolean => {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(match[1], "hex"));
};

/** JSON, or, where the App is set to send forms, the JSON in its `payload` field. */
export const payloadOf = (body: Buffer): unknown => {
  let text = body.toString("utf8");
  if (text.startsWith("payload=")) text = new URLSearchParams(text).get("payload") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

/**
 * What a delivery says, once its signature is right, with its X-GitHub-Delivery when that is one.
 * Rejects when it could not be taken in.
 */
export type GitHubEventHandler = (
  event: string,
  payload: Record<string, unknown>,
  delivery: string | undefined,
) => Promise<void>;

/** GitHub's ids of deliveries are GUIDs; anything else is not kept as one. */
const deliveryId = (value: string | undefined) =>
  value !== undefined && /^[0-9a-f-]{8,64}$/i.test(value) ? value.toLowerCase() : undefined;

/**
 * POST /api/github/webhook. It checks who sent it, notes it in the log, and passes what it says to
 * `onEvent`: installations and authorizations for now, pushes with saving to GitHub. A delivery
 * that could not be taken in is answered with 500, which GitHub shows as failed, to deliver again.
 */
export const webhookRoutes = async (
  app: FastifyInstance,
  {
    secret,
    onEvent,
    onDelivery,
  }: {
    secret: string | undefined;
    onEvent?: GitHubEventHandler | undefined;
    /** Told of each delivery whose signature is right (the GitHub App test page listens). */
    onDelivery?:
      ((event: string | undefined, delivery: string | undefined, body: Buffer) => void) | undefined;
  },
) => {
  // The signature is over the exact bytes, so nothing here parses them first.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer", bodyLimit: WEBHOOK_BODY_LIMIT },
    (_request, body, done) => done(null, body),
  );

  app.post(
    "/api/github/webhook",
    { config: { access: { none: "deliveries of GitHub, signed with the secret" } } },
    async (request, reply) => {
      if (secret === undefined) {
        request.log.warn("GitHub webhook received, but GITHUB_WEBHOOK_SECRET is not set");
        return reply.code(503).send({ error: "not configured" });
      }
      const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (!signatureMatches(secret, body, one(request.headers["x-hub-signature-256"]))) {
        request.log.warn("GitHub webhook with a wrong signature");
        return reply.code(401).send({ error: "bad signature" });
      }
      const event = one(request.headers["x-github-event"]);
      const delivery = one(request.headers["x-github-delivery"]);
      request.log.info({ githubEvent: event, delivery, bytes: body.length }, "GitHub webhook");
      onDelivery?.(event, delivery, body);
      if (onEvent && event) {
        const payload = payloadOf(body);
        if (typeof payload !== "object" || payload === null || Array.isArray(payload))
          return reply.code(400).send({ error: "not JSON" });
        try {
          await onEvent(event, payload as Record<string, unknown>, deliveryId(delivery));
        } catch (error) {
          request.log.error(
            { githubEvent: event, delivery, err: describeError(error) },
            "GitHub webhook not taken in",
          );
          return reply.code(500).send({ error: "not taken in" });
        }
      }
      return reply.code(204).send();
    },
  );
};
