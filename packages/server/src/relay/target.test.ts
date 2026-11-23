import { describe, expect, test } from "vitest";
import { RelayGate, RELAY_LIMITS } from "./gate.ts";
import { answerHeadersOf, RELAY_USER_AGENT, requestHeadersFor } from "./headers.ts";
import { checkHostname, targetOf } from "./target.ts";

describe("where a request goes", () => {
  test("is https://<name>/<path>, as the editor wrote it", () => {
    expect(targetOf("/api/llm-relay/https/api.moonshot.cn/v1/chat/completions")).toEqual({
      hostname: "api.moonshot.cn",
      path: "/v1/chat/completions",
    });
    expect(
      targetOf(
        "/api/llm-relay/https/Generativelanguage.GoogleAPIs.com/v1beta/models/x:stream?alt=sse",
      ),
    ).toEqual({
      hostname: "generativelanguage.googleapis.com",
      path: "/v1beta/models/x:stream?alt=sse",
    });
    expect(targetOf("/api/llm-relay/https/api.example.com")).toEqual({
      hostname: "api.example.com",
      path: "/",
    });
    expect(targetOf("/api/llm-relay/https/api.example.com?x=1")).toEqual({
      hostname: "api.example.com",
      path: "/?x=1",
    });
    expect(targetOf("/api/llm-relay/https/xn--fiqs8s.xn--fiqz9s/v1")?.hostname).toBe(
      "xn--fiqs8s.xn--fiqz9s",
    );
  });

  test("only https, only its port, only a name that can be on the internet", () => {
    for (const url of [
      "/api/llm-relay/http/api.example.com/v1",
      "/api/llm-relay/ftp/api.example.com/v1",
      "/api/llm-relay/HTTPS/api.example.com/v1",
      "/api/llm-relay/https/api.example.com:443/v1",
      "/api/llm-relay/https/api.example.com:8443/v1",
      "/api/llm-relay/https//v1",
      "/api/llm-relay/https",
      "/api/llm-relay/",
      "/api/llm-relay/https/db/v1",
      "/api/llm-relay/https/platform-api/v1",
      "/api/llm-relay/https/localhost/v1",
      "/api/llm-relay/https/app.localhost/v1",
      "/api/llm-relay/https/printer.local/v1",
      "/api/llm-relay/https/metadata.google.internal/v1",
      "/api/llm-relay/https/1.0.0.127.in-addr.arpa/v1",
      "/api/llm-relay/https/api.example.com./v1",
      "/api/llm-relay/https/.example.com/v1",
      "/api/llm-relay/https/api..example.com/v1",
      "/api/llm-relay/https/-api.example.com/v1",
      "/api/llm-relay/https/api_1.example.com/v1",
      "/api/llm-relay/https/api.example.com%2F..%2F/v1",
      "/api/llm-relay/https/user@api.example.com/v1",
      "/api/llm-relay/https/127.0.0.1/v1",
      "/api/llm-relay/https/0.0.0.0/v1",
      "/api/llm-relay/https/[::1]/v1",
      "/api/llm-relay/https/::1/v1",
      "/api/llm-relay/https/api.example.com/v1#x",
      "/api/llm-relay/https/api.example.com/v1/é",
      `/api/llm-relay/https/${"a".repeat(64)}.example.com/v1`,
      `/api/llm-relay/https/${"a.".repeat(127)}com/v1`,
      `/api/llm-relay/https/api.example.com/${"x".repeat(9000)}`,
      "/api/other/https/api.example.com/v1",
    ])
      expect(targetOf(url), url).toBeUndefined();
    expect(checkHostname("api.example.com")).toBe("api.example.com");
    expect(checkHostname("1.2.3.4.nip.io")).toBe("1.2.3.4.nip.io");
  });
});

describe("what crosses the relay", () => {
  const BROWSER = {
    host: "editor.example.com",
    cookie: "__Host-aq_session=secret-session-value",
    origin: "https://editor.example.com",
    referer: "https://editor.example.com/",
    "x-animaquill": "1",
    "x-forwarded-for": "198.51.100.7",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "editor.example.com",
    "x-real-ip": "198.51.100.7",
    forwarded: "for=198.51.100.7",
    via: "2.0 Caddy",
    "sec-fetch-site": "same-origin",
    "sec-ch-ua": '"Chromium"',
    "user-agent": "Mozilla/5.0",
    "accept-encoding": "gzip, br",
    "accept-language": "zh-CN",
    connection: "keep-alive",
    "content-length": "12",
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: "Bearer sk-the-key",
    "x-api-key": "sk-ant-the-key",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "x-stainless-os": "Linux",
    "x-goog-api-key": "AIza-the-key",
    "http-referer": "https://github.com/animaquill/animaquill",
    "x-title": "AnimaQuill",
  };

  test("only what services need goes on: nothing of this site, of the gateway or of the connection", () => {
    expect(requestHeadersFor(BROWSER, "api.example.com")).toEqual({
      host: "api.example.com",
      "user-agent": RELAY_USER_AGENT,
      "accept-encoding": "identity",
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: "Bearer sk-the-key",
      "x-api-key": "sk-ant-the-key",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-stainless-os": "Linux",
      "x-goog-api-key": "AIza-the-key",
      "http-referer": "https://github.com/animaquill/animaquill",
      "x-title": "AnimaQuill",
    });
  });

  test("people's own headers go on under their names, but never as anything of this site", () => {
    expect(
      requestHeadersFor(
        {
          "content-type": "application/json",
          authorization: "Bearer sk-the-key",
          "aq-pass-x-gateway-team": "video",
          "aq-pass-x-portkey-config": "pc-1",
          "aq-pass-cookie": "__Host-aq_session=stolen",
          "aq-pass-host": "inside.example",
          "aq-pass-x-forwarded-for": "10.0.0.1",
          "aq-pass-x-animaquill": "1",
          "aq-pass-x-animaquill-admin": "1",
          "aq-pass-aq-pass-x-secret": "x",
          "aq-pass-true-client-ip": "1.2.3.4",
          "aq-pass-cf-connecting-ip": "1.2.3.4",
          "aq-pass-x-client-ip": "1.2.3.4",
          "aq-pass-authorization": "Bearer other",
          "aq-pass-user-agent": "pretend",
          "aq-pass-": "nothing",
          "x-gateway-team": "not passed without the prefix",
        },
        "api.example.com",
      ),
    ).toEqual({
      host: "api.example.com",
      "user-agent": RELAY_USER_AGENT,
      "accept-encoding": "identity",
      "content-type": "application/json",
      authorization: "Bearer sk-the-key",
      "x-gateway-team": "video",
      "x-portkey-config": "pc-1",
    });
  });

  test("nothing of a service's answer gets to set anything of this site", () => {
    expect(
      answerHeadersOf({
        "content-type": "text/event-stream",
        "content-length": "100",
        "transfer-encoding": "chunked",
        connection: "keep-alive",
        "set-cookie": ["__Host-aq_session=theirs; Path=/; Secure"],
        location: "/api/auth/logout",
        refresh: "0; url=/",
        "www-authenticate": 'Basic realm="x"',
        "clear-site-data": '"*"',
        "alt-svc": 'h3=":443"',
        "strict-transport-security": "max-age=0",
        "content-security-policy": "default-src *",
        "access-control-allow-origin": "*",
        link: "</evil.js>; rel=preload",
        "service-worker-allowed": "/",
        "retry-after": "3",
        "x-request-id": "req_1",
        "x-ratelimit-remaining-requests": "9",
        "anthropic-ratelimit-tokens-remaining": "100",
        "x-should-retry": "false",
      }),
    ).toEqual({
      "content-type": "text/event-stream",
      "retry-after": "3",
      "x-request-id": "req_1",
      "x-ratelimit-remaining-requests": "9",
      "anthropic-ratelimit-tokens-remaining": "100",
      "x-should-retry": "false",
    });
  });
});

describe("the gate", () => {
  const limits = {
    ...RELAY_LIMITS,
    requestsPerUser: 3,
    bytesPerUser: 100,
    windowMs: 1000,
    concurrentPerUser: 2,
    concurrent: 3,
  };

  test("lets each person in so often, so much and so many at once, and everyone so many", () => {
    let now = 0;
    const gate = new RelayGate(limits, () => now);
    const a1 = gate.enter("a");
    const a2 = gate.enter("a");
    const a3 = gate.enter("a");
    expect([a1.ok, a2.ok, a3.ok]).toEqual([true, true, false]);
    expect(a3.ok || a3.who).toBe("user");
    const b1 = gate.enter("b");
    const c1 = gate.enter("c");
    expect(b1.ok).toBe(true);
    expect(c1.ok || c1.who).toBe("everyone");
    expect(gate.running()).toBe(3);

    // Leaving twice counts once.
    if (a1.ok) {
      a1.pass.leave();
      a1.pass.leave();
    }
    expect(gate.running("a")).toBe(1);
    const a4 = gate.enter("a");
    expect(a4.ok).toBe(true);
    if (a4.ok) a4.pass.leave();
    // That was the third of the window.
    const a5 = gate.enter("a");
    expect(a5.ok || a5.who).toBe("user");
    expect(a5.ok || a5.retryAfter).toBeGreaterThan(0);

    now = 1000;
    if (a2.ok) {
      a2.pass.bytes(150);
      a2.pass.leave();
    }
    // Too many bytes in this window, however few requests.
    const a6 = gate.enter("a");
    expect(a6.ok || a6.who).toBe("user");
    now = 2000;
    const a7 = gate.enter("a");
    expect(a7.ok).toBe(true);
  });
});
