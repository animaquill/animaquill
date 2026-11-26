import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BINDING_KEY,
  bindingFetch,
  fetchEventSource,
  signInLocally,
  syncProtocols,
} from "./local.ts";

/**
 * The page's side of the backend of `npx animaquill`: the token out of the address, the key of
 * binding on every request to /api of this site and nowhere else, and the stream of what changed
 * without `EventSource`, which cannot send it.
 */

const ORIGIN = "http://animaquill.localhost:7651";
const KEY = "k".repeat(43);

afterEach(() => vi.unstubAllGlobals());

const page = (href: string) => {
  const replaced: string[] = [];
  const location = new URL(href);
  vi.stubGlobal("location", {
    get href() {
      return location.href;
    },
    get origin() {
      return location.origin;
    },
    get hash() {
      return location.hash;
    },
  });
  vi.stubGlobal("history", {
    state: null,
    replaceState: (_state: unknown, _title: string, url: string) => {
      replaced.push(url);
      location.href = new URL(url, location.href).href;
    },
  });
  return { replaced, location };
};

describe("the key of binding", () => {
  it("goes with requests of this site to /api, and nowhere else", async () => {
    page(`${ORIGIN}/`);
    const seen: Request[] = [];
    const request = bindingFetch(KEY, async (input) => {
      seen.push(input as Request);
      return new Response("{}");
    });
    await request("/api/projects");
    await request(`${ORIGIN}/api/me/storage`, { method: "POST", headers: { "x-animaquill": "1" } });
    await request("/assets/a.js");
    await request("https://api.example.com/api/x");
    await request("http://animaquill.localhost:7652/api/x");
    expect(seen.map((each) => each.headers.get("x-animaquill-binding"))).toEqual([
      KEY,
      KEY,
      null,
      null,
      null,
    ]);
    expect(seen[1]!.headers.get("x-animaquill")).toBe("1");
    expect(seen[1]!.method).toBe("POST");
    expect(syncProtocols(KEY)).toEqual(["animaquill.v1", `animaquill.binding.${KEY}`]);
  });
});

describe("signing in from the terminal", () => {
  const storage = () => {
    const kept = new Map<string, string>();
    return {
      kept,
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    };
  };

  it("takes the token out of the address before anything, and keeps the key it gets", async () => {
    const { replaced, location } = page(`${ORIGIN}/p/abc?x=1#aq-token=the-token`);
    const kept = storage();
    let asked: { url: string; body: string; seenAt: string } | undefined;
    const got = await signInLocally(kept, async (url, init) => {
      asked = { url: String(url), body: String(init?.body), seenAt: location.href };
      return new Response(JSON.stringify({ binding: KEY }));
    });
    expect(replaced).toEqual([`${ORIGIN}/p/abc?x=1`]);
    expect(asked).toEqual({
      url: "/api/local/session",
      body: JSON.stringify({ token: "the-token" }),
      seenAt: `${ORIGIN}/p/abc?x=1`,
    });
    expect(got).toEqual({ kind: "bound", key: KEY });
    expect(kept.kept.get(BINDING_KEY)).toBe(KEY);
  });

  it("goes on with the key it had, where the token was not taken or there was none", async () => {
    page(`${ORIGIN}/#aq-token=used`);
    const kept = storage();
    kept.setItem(BINDING_KEY, KEY);
    expect(await signInLocally(kept, async () => new Response("{}", { status: 401 }))).toEqual({
      kind: "bound",
      key: KEY,
    });
    page(`${ORIGIN}/`);
    const nothing = vi.fn();
    expect(await signInLocally(storage(), nothing)).toEqual({ kind: "unbound" });
    expect(nothing).not.toHaveBeenCalled();
    page(`${ORIGIN}/`);
    const wrong = storage();
    wrong.setItem(BINDING_KEY, "not a key");
    expect(await signInLocally(wrong, nothing)).toEqual({ kind: "unbound" });
  });
});

describe("the stream of what changed, by fetch", () => {
  it("tells its events by name, and stops for good on an answer that is no stream", async () => {
    page(`${ORIGIN}/`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const text = new TextEncoder().encode(
          'retry: 5000\nevent: ready\ndata: {}\n\ndata: {"t":"projects"}\r\n\r\n: ping\n\n',
        );
        controller.enqueue(text.slice(0, 10));
        controller.enqueue(text.slice(10));
      },
    });
    let headers: Headers | undefined;
    const source = fetchEventSource("/api/me/events", async (_url, init) => {
      headers = new Headers(init?.headers);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const heard: string[] = [];
    source.addEventListener("ready", () => heard.push("ready"));
    source.addEventListener("message", () => heard.push("message"));
    await vi.waitFor(() => expect(heard).toEqual(["ready", "message"]));
    expect(source.readyState).toBe(1);
    expect(headers?.get("accept")).toBe("text/event-stream");
    source.close();
    expect(source.readyState).toBe(2);

    const refused = fetchEventSource(
      "/api/me/events",
      async () => new Response("", { status: 401 }),
    );
    const errors: number[] = [];
    refused.addEventListener("error", () => errors.push(refused.readyState));
    await vi.waitFor(() => expect(errors).toEqual([2]));
  });
});
