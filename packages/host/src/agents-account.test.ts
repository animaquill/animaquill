import { afterEach, describe, expect, it, vi } from "vitest";
import { accountAgents } from "./agents-account.ts";
import type { AgentRoomEvents } from "./agents.ts";

/**
 * The page's side of what the conversations of a project say to each other online, against a
 * platform the test speaks for (the real one: me/agents-account.test.ts of the server): what it
 * sends is what PostgreSQL takes; a window that was not there for a while asks at once what it
 * still has, and hears it lost one; a page that comes back says which time of it it is, and its
 * leave of before says the time before.
 */

interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | undefined;
}

/** A platform that answers as the test says; what was asked, in order. */
function platform() {
  const sent: Sent[] = [];
  let owned: string[] = [];
  let waits: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api\/me\/projects\/p1\/agents/, "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ method: init?.method ?? "GET", path, body });
    const answer =
      path.startsWith("/windows/") && init?.method === "PUT"
        ? { owned, waits, mail: [], budget: { count: 0, at: 0 } }
        : path === "/mail"
          ? { result: "posted" }
          : {};
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return {
    sent,
    fetch,
    has(now: string[], waiting: string[] = []) {
      owned = now;
      waits = waiting;
    },
  };
}

function told() {
  const said: string[] = [];
  const events: AgentRoomEvents = {
    owned: (id, waited) => void said.push(`owned ${id} ${waited}`),
    mail: (to) => void said.push(`mail ${to}`),
    budget: () => void said.push("budget"),
    queued: (id) => void said.push(`queued ${id}`),
    lost: (id) => void said.push(`lost ${id}`),
    resumed: () => void said.push("resumed"),
  };
  return { said, events };
}

const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("a window of a project online, as the platform has it", () => {
  it("sends nothing PostgreSQL does not take: no NUL, no half of an emoji", async () => {
    vi.useFakeTimers();
    const server = platform();
    const { events } = told();
    const room = accountAgents({
      api: (path) => `/api${path}`,
      fetch: server.fetch,
      listenPageHide: () => () => {},
      listenPageShow: () => () => {},
      listenWake: () => () => {},
    }).enter("p1", events);
    await room.post(
      {
        id: "m-1",
        to: "chat-b",
        from: "chat-a",
        text: "配乐\u0000\ud83d",
        at: 1,
        left: false,
        body: { "na\u0000me": "A\udc00", text: "配乐\u0000\ud83d" },
      },
      { most: 50, repeatMs: 0 },
    );
    const mail = server.sent.find((each) => each.path === "/mail")?.body?.mail as Record<
      string,
      unknown
    >;
    expect(mail.text).toBe("配乐�");
    expect(mail.body).toEqual({ name: "A�", text: "配乐�" });
    room.close();
  });

  it("asleep longer than the platform waits: asks at once as it wakes, and hears it lost one another window has now", async () => {
    vi.useFakeTimers();
    const server = platform();
    const { said, events } = told();
    let wake = () => {};
    const room = accountAgents({
      api: (path) => `/api${path}`,
      fetch: server.fetch,
      heartbeatMs: 30_000,
      listenPageHide: () => () => {},
      listenPageShow: () => () => {},
      listenWake: (listener) => {
        wake = listener;
        return () => {};
      },
    }).enter("p1", events);
    server.has(["chat-b"]);
    room.serve(["chat-b"]);
    await settle();
    expect(said).toEqual(["owned chat-b false"]);
    expect(room.owns("chat-b")).toBe(true);
    // The computer slept: the clock went on, the timers did not. Another window has it now.
    server.has([], ["chat-b"]);
    const before = server.sent.length;
    vi.setSystemTime(Date.now() + 5 * 60_000);
    wake();
    await settle();
    expect(server.sent.length).toBe(before + 1);
    expect(said).toEqual(["owned chat-b false", "lost chat-b", "queued chat-b"]);
    expect(room.owns("chat-b")).toBe(false);
    // Woken again right after: nothing more to ask.
    wake();
    await settle();
    expect(server.sent.length).toBe(before + 1);
    room.close();
  });

  it("a page that comes back says which time of it it is; its leave as it went says the one before", async () => {
    vi.useFakeTimers();
    const server = platform();
    const { said, events } = told();
    let hide = () => {};
    let show = () => {};
    const room = accountAgents({
      api: (path) => `/api${path}`,
      fetch: server.fetch,
      listenPageHide: (listener) => {
        hide = listener;
        return () => {};
      },
      listenPageShow: (listener) => {
        show = listener;
        return () => {};
      },
      listenWake: () => () => {},
    }).enter("p1", events);
    server.has(["chat-b"]);
    room.serve(["chat-b"]);
    await settle();
    hide();
    await settle();
    show();
    await settle();
    const leave = server.sent.find((each) => each.path.endsWith("/leave"));
    expect(leave?.body).toMatchObject({ keepCards: true, generation: 0 });
    const again = server.sent.filter((each) => each.body?.again === true);
    expect(again.at(-1)?.body).toMatchObject({ generation: 1, serve: ["chat-b"] });
    // Lost as the page went is not lost to another: it was read again as it came back.
    expect(said).toEqual(["owned chat-b false", "resumed", "owned chat-b true"]);
    room.close();
  });
});
