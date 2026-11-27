import type { ServiceFailure } from "@animaquill/agent";
import { relayRefusalIn } from "@animaquill/host";
import type { TFunction } from "i18next";

/** Where a sentence names the service it could not talk to, and the service has no name known. */
const NO_NAME = "\uE000";

/** What people read about a failure: one sentence of what went wrong, and what was said. */
export interface FailureText {
  readonly advice: string;
  readonly detail: string | undefined;
  /** The relay of the platform refused the request, which `advice` says why. */
  readonly relay: boolean;
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
      relay: true,
    };
  const kind = failure?.kind ?? "other";
  // Each kind has a sentence of its own, by its name (`chat.failed.<kind>`). A name goes between
  // spaces, as Latin words do in Chinese; "服务", where none is known, goes without.
  const said = t as unknown as (key: string, options: object) => string;
  const say = (key: string) => {
    const service = where.service || NO_NAME;
    const text = said(key, { service, interpolation: { escapeValue: false } });
    return text.replace(/ ?\uE000 ?/gu, t("chat.failed.someService"));
  };
  const advice =
    // The platform takes a minute for a whole request: a slow line with a large one runs out.
    where.relayed && message !== undefined && /\b408\b/.test(message)
      ? t("chat.failed.relayUpload")
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
    relay: false,
  };
}
