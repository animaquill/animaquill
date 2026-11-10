import { failureOf } from "@animaquill/agent";
import { relayRefusalBody } from "@animaquill/host/relay";
import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/i18n.ts";
import { failureText } from "./failure.ts";

describe("what people read when a service cannot be talked to", () => {
  it("says it was the relay of the platform, and why, when it was", async () => {
    const { t } = await createI18n();
    const said = `401 ${JSON.stringify(relayRefusalBody("signedOut", "sign in to use the relay"))}`;
    const text = failureText(t, failureOf(said), { relayed: true, canRelay: true });
    expect(text.advice).toBe(t("chat.relay.signedOut"));
    expect(text.detail).toContain("平台的说明");
    // Not that the service took the key for a wrong one, which a 401 alone would say.
    expect(failureOf(said).kind).toBe("key");
    expect(text.advice).not.toBe(t("chat.failed.key"));
  });

  it("says what to do when nothing could be reached, by where the request went", async () => {
    const { t } = await createI18n();
    const failure = failureOf("TypeError: Failed to fetch");
    expect(failureText(t, failure, { relayed: false, canRelay: true }).advice).toBe(
      t("chat.failed.network"),
    );
    expect(failureText(t, failure, { relayed: false, canRelay: false }).advice).toBe(
      t("chat.failed.networkLocal"),
    );
    expect(failureText(t, failure, { relayed: true, canRelay: true }).advice).toBe(
      t("chat.failed.networkRelay"),
    );
    const service = failureOf('401 {"error":{"message":"Incorrect API key provided"}}');
    expect(failureText(t, service, { relayed: true, canRelay: true }).advice).toBe(
      t("chat.failed.key"),
    );
  });

  it("says that a request through the relay has a minute to arrive, when it took longer", async () => {
    const { t } = await createI18n();
    // What the platform answers to a request that took longer than it takes, as libraries say it.
    const slow = failureOf(
      '408 {"error":"Request Timeout","message":"Client Timeout","statusCode":408}',
    );
    expect(failureText(t, slow, { relayed: true, canRelay: true }).advice).toBe(
      t("chat.failed.relayUpload"),
    );
    expect(t("chat.failed.relayUpload")).toContain("一分钟");
    // Straight to a service, a 408 is the service's.
    expect(failureText(t, slow, { relayed: false, canRelay: true }).advice).toBe(
      t("chat.failed.other"),
    );
  });
});
