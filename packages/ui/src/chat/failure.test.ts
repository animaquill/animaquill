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
    expect(text.relay).toBe(true);
    expect(text.detail).toContain("服务器的说明");
    // Not that the service took the key for a wrong one, which a 401 alone would say.
    expect(failureOf(said).kind).toBe("key");
    expect(text.advice).not.toContain("key");
  });

  it("says what to do when nothing could be reached, by where the request went", async () => {
    const { t } = await createI18n();
    const failure = failureOf("TypeError: Failed to fetch");
    const where = { relayed: false, canRelay: true, service: "Anthropic" };
    expect(failureText(t, failure, where).advice).toBe(
      "连不上 Anthropic，可能是浏览器挡住了直连。",
    );
    expect(failureText(t, failure, { ...where, canRelay: false }).advice).toBe(
      "连不上 Anthropic，可能是浏览器挡住了直连，也可能是地址或网络不对。",
    );
    expect(failureText(t, failure, { ...where, relayed: true }).advice).toBe(
      t("chat.failed.networkRelay"),
    );
    const service = failureOf('401 {"error":{"message":"Incorrect API key provided"}}');
    expect(failureText(t, service, { ...where, relayed: true }).advice).toBe(
      "Anthropic 的 key 不对。",
    );
  });

  it("says each kind of failure in one sentence of its own, the service by its name", async () => {
    const { t } = await createI18n();
    const where = { relayed: false, canRelay: true, service: "公司的 <DeepSeek>" };
    const said = (message: string) => failureText(t, failureOf(message), where).advice;
    // One sentence each, none of the others in it, no advice to go to the settings: buttons do.
    const sentences = [
      said("TypeError: Failed to fetch"),
      said("401 invalid x-api-key"),
      said("429 Too many requests"),
      said("404 model not found"),
      said("500 Internal Server Error"),
      said("prompt is too long: 250000 tokens"),
      said("something else"),
    ];
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) {
      expect(sentence).not.toContain("设置");
      expect(sentence.split("。").filter(Boolean)).toHaveLength(1);
    }
    expect(sentences[0]).toContain("公司的 <DeepSeek>");
    expect(sentences[3]).toBe("公司的 <DeepSeek> 找不到这个模型。");
    expect(sentences[5]).toBe("上下文满了。");
    // A service of no name known.
    expect(failureText(t, failureOf("401"), { relayed: false, canRelay: true }).advice).toBe(
      "服务的 key 不对。",
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
      t("chat.failed.other", { service: "服务" }),
    );
  });
});
