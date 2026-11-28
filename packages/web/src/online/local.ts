import { LOCAL_BINDING_KEY, type EventSourceLike } from "@animaquill/host";

/**
 * The page's side of the backend of `npx animaquill` (design O4 of AnimaQuill Cloud, section 2):
 * the terminal opens the editor with a one-time token in the address (`#aq-token=`), which never
 * goes to a server; the page takes it out of the address at once, gives it for a session, and is
 * given the key of binding of that session with the cookie. Every request of the page to /api has
 * the key in a header of its own (`bindingFetch`), and the WebSocket of syncing among its
 * subprotocols, see auth/local-credentials.ts of `@animaquill/server`. The key stays in the page's
 * storage, which is of this port only: a page of another port of `animaquill.localhost` gets the
 * cookie, never the key.
 */

export const BINDING_HEADER = "x-animaquill-binding";
export const SYNC_PROTOCOL = "animaquill.v1";
export const BINDING_PROTOCOL = "animaquill.binding.";
/** Where the page keeps its key, in `localStorage` of this origin. */
export const BINDING_KEY = LOCAL_BINDING_KEY;
const TOKEN_PARAM = "aq-token";

const KEY = /^[A-Za-z0-9_-]{43}$/;

/** A fetch that gives every request of this origin to /api the key of binding. */
export function bindingFetch(key: string, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const request = input instanceof Request ? new Request(input, init) : new Request(url, init);
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return base(request);
    const headers = new Headers(request.headers);
    headers.set(BINDING_HEADER, key);
    return base(new Request(request, { headers }));
  };
}

/** The subprotocols the WebSocket of syncing offers: the one it speaks, and the key. */
export const syncProtocols = (key: string): readonly string[] => [
  SYNC_PROTOCOL,
  `${BINDING_PROTOCOL}${key}`,
];

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/**
 * Server-Sent Events by `fetch`, as `EventSource` cannot send a header: the events of the stream by
 * their name ("message" unless said), "error" when it breaks, which it then tries again after the
 * wait the server said; an answer that is not a stream closes it for good, as `EventSource` does.
 */
export function fetchEventSource(url: string, request: typeof fetch): EventSourceLike {
  const listeners = new Map<string, Set<(event?: { readonly data?: unknown }) => void>>();
  const emit = (type: string, data?: string) => {
    for (const listener of listeners.get(type) ?? [])
      listener(data === undefined ? undefined : { data });
  };
  let readyState = CONNECTING;
  let wait = 3000;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = async () => {
    controller = new AbortController();
    let response: Response;
    try {
      response = await request(url, {
        headers: { accept: "text/event-stream" },
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      return broke();
    }
    if (
      !response.ok ||
      !response.body ||
      !(response.headers.get("content-type") ?? "").startsWith("text/event-stream")
    ) {
      readyState = CLOSED;
      void response.body?.cancel().catch(() => {});
      emit("error");
      return;
    }
    readyState = OPEN;
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let type = "message";
    let hasData = false;
    let data: string[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let end: number;
        while ((end = buffer.search(/\r\n|\r|\n/)) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + (buffer.startsWith("\r\n", end) ? 2 : 1));
          if (line === "") {
            if (hasData) emit(type, data.join("\n"));
            type = "message";
            hasData = false;
            data = [];
            continue;
          }
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const said = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") type = said;
          else if (field === "data") {
            hasData = true;
            data.push(said);
          } else if (field === "retry" && /^\d+$/.test(said)) wait = Number(said);
        }
      }
    } catch {
      // Broken off, as by `close`, or by the network.
    }
    broke();
  };

  const broke = () => {
    if (readyState === CLOSED) return;
    readyState = CONNECTING;
    emit("error");
    timer = setTimeout(() => void run(), wait);
  };

  void run();
  return {
    get readyState() {
      return readyState;
    },
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
    },
    close() {
      readyState = CLOSED;
      clearTimeout(timer);
      controller?.abort();
    },
  };
}

/** What the page has of the backend of this machine for the online mode. */
export type LocalSignIn =
  /** The key of binding, from this start or one before. */
  | { readonly kind: "bound"; readonly key: string }
  /** None: the page was not opened from the terminal, or the token was used or too old. */
  | { readonly kind: "unbound" };

/**
 * As the page starts: the token out of the address at once, given for a session where it came;
 * then the key of binding, the new one or the one kept. Never rejects.
 */
export async function signInLocally(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage(),
  request: typeof fetch = fetch,
): Promise<LocalSignIn> {
  const token = takeToken();
  if (token !== undefined) {
    try {
      const response = await request("/api/local/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-animaquill": "1" },
        body: JSON.stringify({ token }),
        cache: "no-store",
      });
      if (response.ok) {
        const { binding } = (await response.json()) as { binding?: unknown };
        if (typeof binding === "string" && KEY.test(binding)) {
          try {
            storage?.setItem(BINDING_KEY, binding);
          } catch {
            // This page has it all the same; a reload asks for a new token.
          }
          return { kind: "bound", key: binding };
        }
      }
    } catch (error) {
      console.warn("The token of the terminal could not be given", error);
    }
  }
  let kept: string | null | undefined;
  try {
    kept = storage?.getItem(BINDING_KEY);
  } catch {
    kept = undefined;
  }
  return typeof kept === "string" && KEY.test(kept)
    ? { kind: "bound", key: kept }
    : { kind: "unbound" };
}

/** The token of the address, which is gone from it, and from the history, before anything else. */
function takeToken(): string | undefined {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get(TOKEN_PARAM);
  if (token === null) return undefined;
  hash.delete(TOKEN_PARAM);
  const url = new URL(location.href);
  const rest = hash.toString();
  url.hash = rest === "" ? "" : rest;
  history.replaceState(history.state, "", rest === "" ? url.href.replace(/#$/, "") : url.href);
  return token;
}

function safeStorage(): Storage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}
