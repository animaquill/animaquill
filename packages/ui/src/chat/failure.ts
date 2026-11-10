import type { ServiceFailure } from "@animaquill/agent";
import { relayRefusalIn } from "@animaquill/host";
import type { TFunction } from "i18next";

/** What people read about a failure: what to do about it, and what was said. */
export interface FailureText {
  readonly advice: string;
  readonly detail: string | undefined;
}

/**
 * What to tell people about a failure to talk to a service. The relay of the platform says when it
 * was the relay, and why; a service that cannot be reached at all is advice that depends on whether
 * a relay is there, and whether the request went through it already.
 */
export function failureText(
  t: TFunction,
  failure: ServiceFailure | undefined,
  where: { readonly relayed: boolean; readonly canRelay: boolean },
): FailureText {
  const message = failure?.message || undefined;
  const refusal = message === undefined ? undefined : relayRefusalIn(message);
  if (refusal)
    return { advice: t(`chat.relay.${refusal}`), detail: t("chat.relayDetail", { message }) };
  const kind = failure?.kind ?? "other";
  const advice =
    // The platform takes a minute for a whole request: a slow line with a large one runs out.
    where.relayed && message !== undefined && /\b408\b/.test(message)
      ? t("chat.failed.relayUpload")
      : kind !== "network"
        ? t(`chat.failed.${kind}`)
        : where.relayed
          ? t("chat.failed.networkRelay")
          : where.canRelay
            ? t("chat.failed.network")
            : t("chat.failed.networkLocal");
  return { advice, detail: message === undefined ? undefined : t("chat.detail", { message }) };
}
