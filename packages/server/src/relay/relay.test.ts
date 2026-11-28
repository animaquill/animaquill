import { request, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { testCertificates } from "../test/certificates.ts";
import { FAKE_REPLY, SLOW_WORD, startFakeLlm, type FakeLlm } from "../test/fake-llm.ts";
import { buildApp } from "../app.ts";
import type { Accounts } from "../auth/accounts.ts";
import { loadConfig } from "../config.ts";
import type { RelayLimits } from "./gate.ts";
import { RELAY_USER_AGENT } from "./headers.ts";
import { Networks } from "./addresses.ts";
import { relayAgent, type RelayNetwork } from "./network.ts";
import type { RelayUse } from "./use.ts";

/**
 * The relay against servers on this machine that stand in for the internet: `provider` is a
 * service, at an address of the internet that DNS gives for its names (rerouted to 127.0.0.2 once
 * the relay has checked it), and `inside` is something around the platform, at 127.0.0.3 on the
 * same port, which nothing may ever reach. Both speak TLS with certificates of the test for
 * *.llm.test. Nothing here goes to the internet: names are answered by the test.
 */

const ORIGIN = "https://editor.example.com";
/** Where DNS says the services are. */
const SERVICE_ADDRESS = "93.184.215.14";
/** Where DNS says a service is that takes connections and then says nothing, not even TLS. */
const SILENT_ADDRESS = "93.184.215.15";
/** The platform's own address, as DNS has it for editor.example.com. */
const OWN_ADDRESS = "1.2.3.4";
const KEY = "sk-test-0123456789abcdefTHEKEY";
const SESSION = "a".repeat(43);
const OTHER_SESSION = "b".repeat(43);
const WORDS = "这是用户写的话，不能进日志";

let certificates: ReturnType<typeof testCertificates>;
let provider: FakeLlm;
let inside: FakeLlm;
let silent: Server;
const silentSockets = new Set<Socket>();

/** What DNS says, by name, and who asked. A function answers each time anew. */
const names = new Map<string, readonly string[] | (() => readonly string[])>();
const asked: string[] = [];
const network = (): RelayNetwork => ({
  async resolve(name) {
    asked.push(name);
    const found = names.get(name);
    if (found === undefined)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" });
    return typeof found === "function" ? found() : found;
  },
  port: provider.port,
  reroute: (address) =>
    address === SERVICE_ADDRESS ? "127.0.0.2" : address === SILENT_ADDRESS ? "127.0.0.4" : address,
  ca: certificates.ca,
});

const signedIn = (userId: string) => ({
  userId,
  kind: "github" as const,
  githubId: 1,
  login: userId,
  avatarUrl: null,
  installed: true,
  renewed: false,
  expiresAt: new Date(Date.now() + 86_400_000),
});
/** How long asking who a session is takes, for tests of a browser that goes meanwhile. */
let sessionDelayMs = 0;
const accounts = {
  session: async (id: string) => {
    if (sessionDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, sessionDelayMs));
    return id === SESSION
      ? signedIn("user-1")
      : id === OTHER_SESSION
        ? signedIn("user-2")
        : undefined;
  },
} as unknown as Accounts;

beforeAll(async () => {
  certificates = testCertificates(["llm.test", "*.llm.test"]);
  provider = await startFakeLlm({ ...certificates, host: "127.0.0.2", port: 0 });
  inside = await startFakeLlm({ ...certificates, host: "127.0.0.3", port: provider.port });
  silent = createServer((socket) => {
    silentSockets.add(socket);
    socket.on("close", () => silentSockets.delete(socket));
  });
  await new Promise<void>((resolve) => silent.listen(provider.port, "127.0.0.4", resolve));
});

afterAll(async () => {
  for (const socket of silentSockets) socket.destroy();
  await new Promise<void>((resolve) => silent.close(() => resolve()));
  await provider.close();
  await inside.close();
});

const opened: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const app of opened.splice(0)) await app.close();
  provider.seen.length = 0;
  inside.seen.length = 0;
  asked.length = 0;
  names.clear();
  sessionDelayMs = 0;
  const { openAiCompatible } = await import("../test/fake-llm.ts");
  provider.answer = openAiCompatible;
});

/** The API with the relay, on a port of its own, with what it logs and counts. */
async function relay({
  env = {},
  limits = {},
}: { env?: Record<string, string>; limits?: Partial<RelayLimits> } = {}) {
  names.set("editor.example.com", [OWN_ADDRESS]);
  names.set("llm.test", [SERVICE_ADDRESS]);
  names.set("api.llm.test", [SERVICE_ADDRESS]);
  const lines: string[] = [];
  const used: RelayUse[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const app = buildApp(
    loadConfig({ PUBLIC_ORIGIN: ORIGIN, ...env }, () => undefined),
    {
      checkDatabase: async () => true,
      ready: () => true,
      accounts: () => accounts,
      relay: {
        network: network(),
        limits,
        interfaces: [],
        usage: () => ({ record: async (use) => void used.push(use) }),
      },
    },
    { level: "info", stream },
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  opened.push(app);
  const { port } = app.server.address() as AddressInfo;
  return { app, port, lines, used };
}

interface Got {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  /** When each piece of the body came, in milliseconds from the first. */
  readonly arrivals: readonly number[];
  /** The answer stopped short. */
  readonly broken: boolean;
}

/** What a page of the editor sends with every request to the relay. */
const PAGE = {
  origin: ORIGIN,
  "x-animaquill": "1",
  cookie: `__Host-aq_session=${SESSION}; other=1`,
  authorization: `Bearer ${KEY}`,
  "content-type": "application/json",
  "x-stainless-os": "Linux",
  "sec-fetch-site": "same-origin",
  "x-forwarded-for": "198.51.100.7",
  referer: `${ORIGIN}/`,
};

const chat = (words = WORDS) =>
  JSON.stringify({
    model: "fake-model",
    stream: true,
    messages: [{ role: "user", content: words }],
  });

/** Sends a request to the relay. `request` is there to stop it. */
function send(
  port: number,
  {
    method = "POST",
    path = "/api/llm-relay/https/llm.test/v1/chat/completions",
    headers = PAGE as Record<string, string>,
    body = method === "POST" ? chat() : undefined,
    chunked = false,
  }: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string | undefined;
    chunked?: boolean;
  } = {},
): { request: ClientRequest; done: Promise<Got>; started: Promise<void> } {
  let started!: () => void;
  const first = new Promise<void>((resolve) => (started = resolve));
  let outgoing!: ClientRequest;
  const done = new Promise<Got>((resolve, reject) => {
    outgoing = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...headers,
          ...(body !== undefined && !chunked && { "content-length": Buffer.byteLength(body) }),
        },
      },
      (response) => {
        const pieces: Buffer[] = [];
        const arrivals: number[] = [];
        let at: number | undefined;
        let broken = false;
        response.on("data", (piece: Buffer) => {
          at ??= performance.now();
          arrivals.push(performance.now() - at);
          pieces.push(piece);
          started();
        });
        const finish = () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(pieces).toString("utf8"),
            arrivals,
            broken,
          });
        response.on("aborted", () => (broken = true));
        response.on("error", () => (broken = true));
        response.on("close", finish);
      },
    );
    outgoing.on("error", (error) => {
      if (outgoing.destroyed) reject(error);
    });
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
  done.catch(() => {});
  return { request: outgoing, done, started: first };
}

const errorOf = (got: Got) => (JSON.parse(got.body) as { error: { code: string } }).error.code;

describe("the relay", () => {
  test("streams the answer of a service to a signed-in page, which gets only what it needs", async () => {
    const { port, used } = await relay();
    const got = await send(port, {
      path: "/api/llm-relay/https/llm.test/v1/chat/completions?api-version=1",
    }).done;
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toBe("text/event-stream");
    expect(got.headers["cache-control"]).toBe("no-store");
    for (const word of FAKE_REPLY) expect(got.body).toContain(JSON.stringify(word));
    expect(got.body).toContain("data: [DONE]");
    // As it came: the service writes a piece every 40 ms.
    expect(got.arrivals.length).toBeGreaterThan(2);
    expect(got.arrivals.at(-1)).toBeGreaterThan(80);

    // The service got the request as the page wrote it, and nothing of this site.
    const [seen] = provider.seen;
    expect(seen?.method).toBe("POST");
    expect(seen?.path).toBe("/v1/chat/completions?api-version=1");
    expect(seen?.body).toBe(chat());
    expect(seen?.headers).toMatchObject({
      host: "llm.test",
      authorization: `Bearer ${KEY}`,
      "x-stainless-os": "Linux",
      "content-type": "application/json",
      "user-agent": RELAY_USER_AGENT,
    });
    for (const name of [
      "cookie",
      "origin",
      "referer",
      "x-animaquill",
      "x-forwarded-for",
      "x-real-ip",
      "forwarded",
      "sec-fetch-site",
    ])
      expect(seen?.headers, name).not.toHaveProperty(name);
    expect(JSON.stringify(seen?.headers)).not.toContain(SESSION);
    expect(inside.seen).toEqual([]);
    await expect.poll(() => used.length).toBe(1);
    expect(used).toEqual([
      {
        userId: "user-1",
        at: expect.any(Date),
        sent: Buffer.byteLength(chat()),
        received: Buffer.byteLength(got.body),
      },
    ]);
  });

  test("passes on the models of a service, which a page asks for without an Origin", async () => {
    const { port } = await relay();
    const { origin: _origin, ...headers } = PAGE;
    const got = await send(port, {
      method: "GET",
      path: "/api/llm-relay/https/api.llm.test/v1/models",
      headers,
    }).done;
    expect(got.status).toBe(200);
    expect(JSON.parse(got.body)).toMatchObject({ data: [{ id: "fake-model" }, {}] });
    expect(provider.seen[0]?.headers.host).toBe("api.llm.test");
  });

  test("passes on what the service says when it refuses, but nothing that would set anything of this site", async () => {
    const { port } = await relay();
    provider.answer = (_request, response) => {
      response.writeHead(401, {
        "content-type": "application/json",
        "set-cookie": "__Host-aq_session=theirs; Path=/; Secure; HttpOnly",
        "www-authenticate": 'Basic realm="service"',
        "clear-site-data": '"*"',
        "x-ratelimit-remaining-requests": "7",
      });
      response.end('{"error":{"message":"Incorrect API key provided"}}');
    };
    const got = await send(port).done;
    expect(got.status).toBe(401);
    expect(got.body).toContain("Incorrect API key provided");
    expect(got.headers["x-ratelimit-remaining-requests"]).toBe("7");
    for (const name of ["set-cookie", "www-authenticate", "clear-site-data"])
      expect(got.headers, name).not.toHaveProperty(name);
  });

  test("takes requests only from the editor's pages, of someone signed in", async () => {
    const { port } = await relay();
    const { cookie: _cookie, ...anonymous } = PAGE;
    const cases: [Record<string, string>, string, number, string][] = [
      [anonymous, "POST", 401, "signedOut"],
      [{ ...PAGE, cookie: `__Host-aq_session=${"c".repeat(43)}` }, "POST", 401, "signedOut"],
      [{ ...PAGE, origin: "https://evil.example" }, "POST", 403, "forbidden"],
      [{ ...PAGE, origin: "null" }, "POST", 403, "forbidden"],
      [{ ...PAGE, "x-animaquill": "0" }, "POST", 403, "forbidden"],
      [
        Object.fromEntries(Object.entries(PAGE).filter(([name]) => name !== "x-animaquill")),
        "POST",
        403,
        "forbidden",
      ],
      // A POST always has an Origin in a browser: one without is not a page of the editor.
      [
        Object.fromEntries(Object.entries(PAGE).filter(([name]) => name !== "origin")),
        "POST",
        403,
        "forbidden",
      ],
      [
        {
          ...Object.fromEntries(Object.entries(PAGE).filter(([name]) => name !== "origin")),
          "sec-fetch-site": "cross-site",
        },
        "GET",
        403,
        "forbidden",
      ],
    ];
    for (const [headers, method, status, why] of cases) {
      const got = await send(port, {
        method,
        headers,
        path: "/api/llm-relay/https/llm.test/v1/chat/completions",
      }).done;
      expect(got.status, JSON.stringify(headers)).toBe(status);
      expect(errorOf(got)).toBe(why);
      expect(got.body).toContain(`aq-relay:${why}`);
    }
    expect(provider.seen).toEqual([]);
    expect(asked.filter((name) => name !== "editor.example.com")).toEqual([]);
  });

  test("turned off, takes nothing at all", async () => {
    const { port } = await relay({ env: { LLM_RELAY: "off" } });
    for (const method of ["POST", "GET", "PUT", "OPTIONS"]) {
      const got = await send(port, { method, body: method === "POST" ? chat() : undefined }).done;
      expect(got.status, method).toBe(503);
      expect(errorOf(got)).toBe("off");
    }
    expect(provider.seen).toEqual([]);
    // Anything but on or off is off.
    const unsure = await relay({ env: { LLM_RELAY: "maybe" } });
    expect((await send(unsure.port).done).status).toBe(503);
    expect(provider.seen).toEqual([]);
  });

  test("passes on GET and POST only", async () => {
    const { port } = await relay();
    for (const method of ["PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      const got = await send(port, { method, body: undefined }).done;
      expect(got.status, method).toBe(405);
    }
    expect(provider.seen).toEqual([]);
  });

  test("goes only to https on port 443 of a name that can be on the internet", async () => {
    const { port } = await relay();
    for (const path of [
      "/api/llm-relay/http/llm.test/v1/chat/completions",
      "/api/llm-relay/https/llm.test:8443/v1/chat/completions",
      "/api/llm-relay/https/llm.test:443/v1/chat/completions",
      "/api/llm-relay/https/127.0.0.3/v1/chat/completions",
      "/api/llm-relay/https/2130706433/v1/chat/completions",
      "/api/llm-relay/https/0x7f.0.0.1/v1/chat/completions",
      "/api/llm-relay/https/[::1]/v1/chat/completions",
      "/api/llm-relay/https/0.0.0.0/v1/chat/completions",
      "/api/llm-relay/https/localhost/v1/chat/completions",
      "/api/llm-relay/https/db/v1/chat/completions",
      "/api/llm-relay/https/llm.test./v1/chat/completions",
    ]) {
      const got = await send(port, { path }).done;
      expect(got.status, path).toBe(400);
      expect(errorOf(got)).toBe("badTarget");
    }
    expect(provider.seen).toEqual([]);
    expect(inside.seen).toEqual([]);
    expect(asked.filter((name) => name !== "editor.example.com")).toEqual([]);
  });

  test("never goes inside, nor to the platform itself", async () => {
    const { port } = await relay();
    const answers: Record<string, string[]> = {
      "loopback.llm.test": ["127.0.0.3"],
      "private.llm.test": ["10.0.0.1"],
      "docker.llm.test": ["172.18.0.2"],
      "metadata.llm.test": ["169.254.169.254"],
      "shared.llm.test": ["100.64.0.1"],
      "zero.llm.test": ["0.0.0.0"],
      "v6.llm.test": ["::1"],
      "mapped.llm.test": ["::ffff:127.0.0.3"],
      "nat64.llm.test": ["64:ff9b::7f00:3"],
      "local6.llm.test": ["fd00::3"],
      "mixed.llm.test": [SERVICE_ADDRESS, "127.0.0.3"],
      "own.llm.test": [OWN_ADDRESS],
    };
    for (const [name, addresses] of Object.entries(answers)) names.set(name, addresses);
    for (const name of Object.keys(answers)) {
      const got = await send(port, {
        path: `/api/llm-relay/https/${name}/v1/chat/completions`,
      }).done;
      // As a name that is not there at all, see the test of that below.
      expect(got.status, name).toBe(502);
      expect(errorOf(got)).toBe("unreachable");
    }
    // Its own name it knows without asking anyone, and says so.
    const self = await send(port, {
      path: "/api/llm-relay/https/editor.example.com/v1/chat/completions",
    }).done;
    expect(self.status).toBe(403);
    expect(errorOf(self)).toBe("blocked");
    expect(inside.seen).toEqual([]);
    expect(provider.seen).toEqual([]);
  });

  test("connects to the address it checked: a name that turns to an inside one later does not get there", async () => {
    const { port } = await relay({ limits: { keepMs: 50 } });
    let lookups = 0;
    // DNS rebinding: on the internet when the relay first asks, inside after that.
    names.set("rebind.llm.test", () => (++lookups === 1 ? [SERVICE_ADDRESS] : ["127.0.0.3"]));
    const path = "/api/llm-relay/https/rebind.llm.test/v1/chat/completions";
    const first = await send(port, { path }).done;
    expect(first.status).toBe(200);
    expect(provider.seen).toHaveLength(1);
    expect(inside.seen).toEqual([]);
    expect(lookups).toBe(1);

    // The connection it kept is gone by now: the next one looks the name up again, and is refused.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await send(port, { path }).done;
    expect(second.status).toBe(502);
    expect(errorOf(second)).toBe("unreachable");
    expect(inside.seen).toEqual([]);
  });

  test("checks the certificate against the name, whatever address it has", async () => {
    const { port } = await relay();
    names.set("elsewhere.test", [SERVICE_ADDRESS]);
    const got = await send(port, {
      path: "/api/llm-relay/https/elsewhere.test/v1/chat/completions",
    }).done;
    expect(got.status).toBe(502);
    expect(errorOf(got)).toBe("unreachable");
    expect(got.body).toContain("certificate");
    expect(provider.seen).toEqual([]);
  });

  test("does not follow a redirect, nor pass it on", async () => {
    const { port } = await relay();
    provider.answer = (_request, response) => {
      response.writeHead(307, { location: "https://elsewhere.llm.test/v1/chat?token=secret" });
      response.end();
    };
    const got = await send(port).done;
    expect(got.status).toBe(502);
    expect(errorOf(got)).toBe("redirect");
    expect(got.headers).not.toHaveProperty("location");
    expect(got.body).toContain("https://elsewhere.llm.test/v1/chat");
    expect(got.body).not.toContain("secret");
    expect(provider.seen).toHaveLength(1);
    expect(asked).not.toContain("elsewhere.llm.test");
  });

  test("stops the service as soon as the page stops, and lets go of its connection", async () => {
    const { port, used } = await relay({ limits: { concurrentPerUser: 1 } });
    const slow = send(port, { body: chat("慢慢来") });
    await slow.started;
    expect(provider.seen).toHaveLength(1);
    const stoppedAt = performance.now();
    slow.request.destroy();
    await expect
      .poll(() => provider.seen[0]?.cut && provider.seen[0]?.closed, {
        timeout: 2000,
        interval: 10,
      })
      .toBe(true);
    expect(performance.now() - stoppedAt).toBeLessThan(1000);
    // Its place is free again.
    await expect.poll(() => used.length, { timeout: 2000 }).toBe(1);
    const next = await send(port).done;
    expect(next.status).toBe(200);
  });

  test("a request too large never gets there, and one that grows too large is cut", async () => {
    const { port } = await relay({ limits: { requestBytes: 1000 } });
    const large = chat("x".repeat(2000));
    const declared = await send(port, { body: large }).done;
    expect(declared.status).toBe(413);
    expect(errorOf(declared)).toBe("tooLarge");
    expect(provider.seen).toEqual([]);

    const streamed = await send(port, { body: large, chunked: true }).done;
    expect(streamed.status).toBe(413);
    expect(errorOf(streamed)).toBe("tooLarge");
    // The service never got all of it.
    expect(provider.seen.every((seen) => seen.body !== large)).toBe(true);
  });

  test("an answer too long is cut short, and the service with it", async () => {
    const { port } = await relay({ limits: { answerBytes: 1500 } });
    const got = await send(port, { body: chat("慢慢来") }).done;
    expect(got.status).toBe(200);
    expect(got.broken || !got.body.includes("[DONE]")).toBe(true);
    expect(Buffer.byteLength(got.body)).toBeLessThanOrEqual(1500);
    await expect.poll(() => provider.seen[0]?.cut, { timeout: 2000 }).toBe(true);
  });

  test("lets each person in so often, and so many at once", async () => {
    const often = await relay({ limits: { requestsPerUser: 2 } });
    expect((await send(often.port).done).status).toBe(200);
    expect((await send(often.port).done).status).toBe(200);
    const third = await send(often.port).done;
    expect(third.status).toBe(429);
    expect(errorOf(third)).toBe("busy");
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    // Someone else has turns of their own.
    const other = await send(often.port, {
      headers: { ...PAGE, cookie: `__Host-aq_session=${OTHER_SESSION}` },
    }).done;
    expect(other.status).toBe(200);

    const many = await relay({ limits: { concurrentPerUser: 1 } });
    const slow = send(many.port, { body: chat("慢慢来") });
    await slow.started;
    const again = await send(many.port).done;
    expect(again.status).toBe(429);
    expect(errorOf(again)).toBe("busy");
    slow.request.destroy();
  });

  test("everyone together has a limit too", async () => {
    const { port } = await relay({ limits: { concurrent: 1 } });
    const slow = send(port, { body: chat("慢慢来") });
    await slow.started;
    const other = await send(port, {
      headers: { ...PAGE, cookie: `__Host-aq_session=${OTHER_SESSION}` },
    }).done;
    expect(other.status).toBe(503);
    expect(errorOf(other)).toBe("busy");
    slow.request.destroy();
  });

  test("lets go of a service that takes too long, to connect, to answer, or in all", async () => {
    const { port } = await relay({ limits: { connectMs: 300, idleMs: 300, totalMs: 900 } });
    names.set("silent.llm.test", [SILENT_ADDRESS]);
    const connecting = await send(port, {
      path: "/api/llm-relay/https/silent.llm.test/v1/chat/completions",
    }).done;
    expect(connecting.status).toBe(504);
    expect(errorOf(connecting)).toBe("timeout");

    provider.answer = () => {};
    const waiting = await send(port).done;
    expect(waiting.status).toBe(504);
    expect(errorOf(waiting)).toBe("timeout");
    await expect.poll(() => provider.seen.at(-1)?.cut, { timeout: 2000 }).toBe(true);

    const { openAiCompatible } = await import("../test/fake-llm.ts");
    provider.answer = openAiCompatible;
    const started = performance.now();
    const long = await send(port, { body: chat("慢慢来") }).done;
    expect(long.status).toBe(200);
    expect(long.body).toContain(JSON.stringify(SLOW_WORD));
    expect(long.body).not.toContain("[DONE]");
    expect(performance.now() - started).toBeLessThan(3000);
    await expect.poll(() => provider.seen.at(-1)?.cut, { timeout: 2000 }).toBe(true);
  });

  test("keeps nothing of what goes through, and logs no key, no words and no path", async () => {
    const { port, lines } = await relay();
    await send(port, {
      path: "/api/llm-relay/https/llm.test/v1/chat/completions?key=AIza-in-the-query",
    }).done;
    await send(port, { headers: { ...PAGE, origin: "https://evil.example" } }).done;
    await send(port, { path: "/api/llm-relay/https/nowhere.llm.test/v1/chat/completions" }).done;
    const log = lines.join("");
    // Why the last one failed, and nothing of where it was going.
    expect(log).toContain('"relay":{"end":"unreachable","code":"ENOTFOUND"}');
    for (const secret of [
      KEY,
      SESSION,
      WORDS,
      "AIza-in-the-query",
      "/v1/chat/completions",
      "你好",
      "llm.test",
    ])
      expect(log, secret).not.toContain(secret);
  });

  test("lets go of what it relays when the API stops, rather than holding the stop up", async () => {
    const { app, port } = await relay();
    const slow = send(port, { body: chat("慢慢来") });
    await slow.started;
    const stopping = performance.now();
    await app.close();
    opened.splice(opened.indexOf(app), 1);
    expect(performance.now() - stopping).toBeLessThan(2000);
    const got = await slow.done;
    expect(got.broken || !got.body.includes("[DONE]")).toBe(true);
    await expect.poll(() => provider.seen.at(-1)?.cut, { timeout: 2000 }).toBe(true);
  });

  test("a status that HTTP does not have takes nothing down: the page hears that it failed", async () => {
    const { port } = await relay();
    for (const status of [600, 999]) {
      provider.answer = (_request, response) => {
        response.writeHead(status, { "content-type": "text/plain" });
        response.end("ok");
      };
      const got = await send(port).done;
      expect(got.status, String(status)).toBe(502);
      expect(errorOf(got)).toBe("failed");
    }
    const { openAiCompatible } = await import("../test/fake-llm.ts");
    provider.answer = openAiCompatible;
    expect((await send(port).done).status).toBe(200);
  });

  test("a page that goes while it is asked who it is takes no place, and nothing of it reaches the service", async () => {
    sessionDelayMs = 300;
    const { port } = await relay({ limits: { concurrentPerUser: 1 } });
    for (const whole of [true, false]) {
      provider.seen.length = 0;
      const body = chat("慢慢来");
      const going = request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/llm-relay/https/llm.test/v1/chat/completions",
        headers: { ...PAGE, "content-length": whole ? Buffer.byteLength(body) : 5000 },
      });
      going.on("error", () => {});
      going.write(whole ? body : body.slice(0, 10));
      if (whole) going.end();
      await new Promise((resolve) => setTimeout(resolve, 100));
      going.destroy();
      // Asking who it was is over by now.
      await new Promise((resolve) => setTimeout(resolve, 400));
      const next = await send(port).done;
      expect(next.status, `the whole body: ${whole}`).toBe(200);
      expect(
        provider.seen.map((seen) => seen.body),
        `the whole body: ${whole}`,
      ).toEqual([chat()]);
    }
  });

  test("stopping before the answer began stops the service at once", async () => {
    const { port } = await relay();
    provider.answer = (_request, response) => {
      // It thinks for four seconds.
      const later = setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: [DONE]\n\n");
      }, 4000);
      response.on("close", () => clearTimeout(later));
    };
    const thinking = send(port);
    await expect.poll(() => provider.seen.length, { timeout: 2000, interval: 10 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const stoppedAt = performance.now();
    thinking.request.destroy();
    await expect.poll(() => provider.seen[0]?.closed, { timeout: 5000, interval: 10 }).toBe(true);
    expect(performance.now() - stoppedAt).toBeLessThan(1000);
    expect(provider.seen[0]?.cut).toBe(true);
  });

  test("a name that points inside is answered as one that is not there at all", async () => {
    const { port } = await relay();
    names.set("loopback.llm.test", ["127.0.0.3"]);
    names.set("docker.llm.test", ["172.18.0.2"]);
    names.set("own.llm.test", [OWN_ADDRESS]);
    const answerOf = async (name: string) => {
      const got = await send(port, {
        path: `/api/llm-relay/https/${name}/v1/chat/completions`,
      }).done;
      return { status: got.status, body: got.body.replaceAll(name, "<name>") };
    };
    // Not in DNS at all.
    const nowhere = await answerOf("nowhere.llm.test");
    for (const name of ["loopback.llm.test", "docker.llm.test", "own.llm.test"])
      expect(await answerOf(name), name).toEqual(nowhere);
    expect(nowhere.status).toBe(502);
    expect(inside.seen).toEqual([]);
  });

  test("an answer is something for the page to read, never a page or a script of this site", async () => {
    const { port } = await relay();
    const types: [string | undefined, string][] = [
      ["text/html; charset=utf-8", "application/octet-stream"],
      ["application/javascript", "application/octet-stream"],
      ["image/svg+xml", "application/octet-stream"],
      ["text/event-stream; charset=utf-8", "text/event-stream; charset=utf-8"],
      ["application/json", "application/json"],
      ["application/problem+json", "application/problem+json"],
      ["application/x-ndjson", "application/x-ndjson"],
      ["text/plain; charset=utf-8", "text/plain; charset=utf-8"],
      // Of several types browsers take the last.
      ["text/plain; charset=utf-8, text/html", "application/octet-stream"],
      [undefined, "application/octet-stream"],
    ];
    for (const [type, expected] of types) {
      provider.answer = (_request, response) => {
        response.writeHead(200, type === undefined ? {} : { "content-type": type });
        response.end("<script>parent.alert(1)</script>");
      };
      const got = await send(port).done;
      expect(got.status).toBe(200);
      expect(got.headers["content-type"], String(type)).toBe(expected);
      expect(got.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(got.headers["cross-origin-resource-policy"]).toBe("same-origin");
    }
    // What the relay says itself too.
    const refused = await send(port, { path: "/api/llm-relay/https/db/v1/models" }).done;
    expect(refused.status).toBe(400);
    expect(refused.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(refused.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  test("goes nowhere the configuration names, as if it were not there", async () => {
    const { port } = await relay({ env: { LLM_RELAY_DENY: "93.184.215.0/24" } });
    const got = await send(port).done;
    expect(got.status).toBe(502);
    expect(errorOf(got)).toBe("unreachable");
    expect(provider.seen).toEqual([]);
  });

  test("logs neither where requests went nor anything of them, only why one failed", async () => {
    const { port, lines } = await relay();
    expect((await send(port).done).status).toBe(200);
    names.set("loopback.llm.test", ["127.0.0.3"]);
    names.set("elsewhere.test", [SERVICE_ADDRESS]);
    for (const name of ["loopback.llm.test", "elsewhere.test", "nowhere.llm.test"])
      await send(port, { path: `/api/llm-relay/https/${name}/v1/chat/completions?x=1` }).done;
    provider.answer = (_request, response) => {
      response.writeHead(307, { location: "https://redirected.llm.test/v1" });
      response.end();
    };
    await send(port).done;
    const log = lines.join("");
    for (const where of [
      "llm.test",
      "elsewhere.test",
      "redirected",
      "/v1/chat/completions",
      SERVICE_ADDRESS,
      "127.0.0.3",
    ])
      expect(log, where).not.toContain(where);
    expect(log).not.toContain('"relayed"');
    // Why the certificate one failed is there, without where it went.
    expect(log).toContain("ERR_TLS_CERT_ALTNAME_INVALID");
  });

  test("goes nowhere until the platform's own addresses are known", async () => {
    const { port } = await relay();
    names.delete("editor.example.com");
    const got = await send(port).done;
    expect(got.status).toBe(503);
    expect(errorOf(got)).toBe("unavailable");
    expect(provider.seen).toEqual([]);
  });
});

describe("the connections of the relay", () => {
  test("are so many at most in all, whatever services they go to", () => {
    const agent = relayAgent({ resolve: async () => [] }, () => new Networks(), {
      sockets: 64,
      keepMs: 4000,
    });
    expect(agent.maxTotalSockets).toBe(64);
    expect(agent.maxSockets).toBeLessThanOrEqual(64);
    agent.destroy();
  });
});
