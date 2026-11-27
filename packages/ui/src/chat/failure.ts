import type { FailureKind, ServiceFailure } from "@animaquill/agent";
import { relayRefusalIn, type RelayRefusal } from "@animaquill/host";
import type { TFunction } from "i18next";

/** Where a sentence names the service it could not talk to, and the service has no name known. */
const NO_NAME = "\uE000";

/**
 * Why a task failed, as the card of the failure tells it apart: the kinds of `ServiceFailure`, the
 * quota of a service used up (which the kind "rate" has with too many requests), and the relay of
 * the platform that refused the request.
 */
export type FailureReason = FailureKind | "quota" | "relay";

/** What people read about a failure: one sentence of what went wrong, and what was said. */
export interface FailureText {
  readonly advice: string;
  readonly detail: string | undefined;
  readonly reason: FailureReason;
  /** Why the relay of the platform refused the request, where it did. */
  readonly refusal?: RelayRefusal;
}

/** A quota used up, as services say it: no use trying again soon. */
const QUOTA = /quota|insufficient[_ ]?(?:balance|funds|credit)|billing|credit balance|余额|额度/iu;
/** How much of what a service said goes into the sentence. */
const SAID_LENGTH = 80;

/**
 * The first sentence of what a service said, for a failure of no kind known: the message of the
 * error where it is JSON, without the status in front.
 */
export function firstSaid(message: string): string {
  const text = message.replace(/^\s*\d{3}\s*/u, "").trim();
  let said = text;
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(text.slice(start)) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      const found =
        (typeof body.error === "object" && body.error?.message) ||
        (typeof body.error === "string" && body.error) ||
        body.message;
      if (typeof found === "string" && found.trim()) said = found.trim();
    } catch {
      // Not JSON after all: the words as they are.
    }
  }
  const [first = ""] = said.split(/(?<=[.!?。！？])\s|\n/u);
  return first.length > SAID_LENGTH ? `${first.slice(0, SAID_LENGTH - 1)}…` : first;
}

/**
 * What to tell people about a failure to talk to a service, one kind of failure in one short
 * sentence (docs/design/chat-panel.md of AnimaQuill Cloud, 7 "出错"): what to do about it is on the
 * buttons beside it. The relay of the platform says when it was the relay, and why; a service that
 * cannot be reached is said by where the request went.
 */
export function failureText(
  t: TFunction,
  failure: ServiceFailure | undefined,
  where: {
    readonly relayed: boolean;
    readonly canRelay: boolean;
    /** What people call the service, where it is known. */
    readonly service?: string | undefined;
  },
): FailureText {
  const message = failure?.message || undefined;
  const refusal = message === undefined ? undefined : relayRefusalIn(message);
  if (refusal)
    return {
      advice: t(`chat.relay.${refusal}`),
      detail: t("chat.relayDetail", { message }),
      reason: "relay",
      refusal,
    };
  const given = failure?.kind ?? "other";
  const kind: FailureReason =
    given === "rate" && message !== undefined && QUOTA.test(message) ? "quota" : given;
  // Each kind has a sentence of its own, by its name (`chat.failed.<kind>`). A name goes between
  // spaces, as Latin words do in Chinese; "服务", where none is known, goes without.
  const said = t as unknown as (key: string, options: object) => string;
  const say = (key: string, more: object = {}) => {
    const service = where.service || NO_NAME;
    const text = said(key, { service, ...more, interpolation: { escapeValue: false } });
    return text.replace(/ ?\uE000 ?/gu, t("chat.failed.someService"));
  };
  const advice =
    // The platform takes a minute for a whole request: a slow line with a large one runs out.
    where.relayed && message !== undefined && /\b408\b/.test(message)
      ? t("chat.failed.relayUpload")
      : kind === "other"
        ? // No kind of its own: what the service said, its first sentence, is the best there is.
          message === undefined || firstSaid(message) === ""
          ? t("chat.failed.other")
          : say("chat.failed.said", { said: firstSaid(message) })
        : kind !== "network"
          ? say(`chat.failed.${kind}`)
          : where.relayed
            ? t("chat.failed.networkRelay")
            : where.canRelay
              ? say("chat.failed.network")
              : say("chat.failed.networkLocal");
  return {
    advice,
    detail: message === undefined ? undefined : t("chat.detail", { message }),
    reason: kind,
  };
}
