/**
 * What changed of the person's list of projects, as the platform says it at once (`GET
 * /api/me/events` of the server, Server-Sent Events): a project renamed, made or taken away, or
 * organised otherwise, on any computer. `changed` is told each time, and once more as the stream
 * comes (again), for what was missed meanwhile; what it does is read the list again. `live` says
 * whether the stream is there: where it is not, the caller reads the list again by itself now and
 * then. A stream the browser gave up on (the platform said no, as for someone signed out, or too
 * many) is tried again after `againMs`; one that only broke, the browser tries again by itself.
 *
 * The same stream says what the person's conversations of a project say to each other, to
 * `agents` (`event: agents`, see agents-account.ts), as the platform wrote it. However many watch,
 * a page has one stream: a person has only so many.
 */
export interface PersonEventsAccess {
  watch(
    changed: () => void,
    live?: (live: boolean) => void,
    agents?: (data: unknown) => void,
  ): () => void;
}

/** What of `EventSource` this needs: a browser's, or one of a test. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event?: { readonly data?: unknown }) => void): void;
  close(): void;
}

export interface BrowserPersonEventsOptions {
  /** The address of the stream, such as /api/me/events. */
  readonly url: string;
  readonly open?: (url: string) => EventSourceLike;
  readonly againMs?: number;
}

/** `EventSource.CLOSED`: the browser does not try again by itself. */
const CLOSED = 2;

interface Watcher {
  readonly changed: () => void;
  readonly live: ((live: boolean) => void) | undefined;
  readonly agents: ((data: unknown) => void) | undefined;
}

export function browserPersonEvents(options: BrowserPersonEventsOptions): PersonEventsAccess {
  const open = options.open ?? ((url) => new EventSource(url) as unknown as EventSourceLike);
  const againMs = options.againMs ?? 60_000;
  const watchers = new Set<Watcher>();
  let source: EventSourceLike | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let isLive = false;
  /** Tells each watcher: one that throws does not keep the others from hearing it. */
  const each = (what: (watcher: Watcher) => void) => {
    for (const watcher of Array.from(watchers)) {
      try {
        what(watcher);
      } catch (error) {
        console.warn("What the platform said could not be taken in", error);
      }
    }
  };
  const say = (now: boolean) => {
    if (now === isLive) return;
    isLive = now;
    each((watcher) => watcher.live?.(now));
  };
  const connect = () => {
    timer = undefined;
    if (watchers.size === 0) return;
    const opened = open(options.url);
    source = opened;
    opened.addEventListener("ready", () => {
      if (source !== opened) return;
      say(true);
      each((watcher) => watcher.changed());
    });
    opened.addEventListener("message", () => {
      if (source === opened) each((watcher) => watcher.changed());
    });
    opened.addEventListener("agents", (event) => {
      if (source !== opened || typeof event?.data !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      each((watcher) => watcher.agents?.(data));
    });
    opened.addEventListener("error", () => {
      if (source !== opened) return;
      say(false);
      if (opened.readyState !== CLOSED) return;
      opened.close();
      source = undefined;
      clearTimeout(timer);
      timer = setTimeout(connect, againMs);
    });
  };
  return {
    watch(changed, live, agents) {
      const watcher: Watcher = { changed, live, agents };
      watchers.add(watcher);
      if (!source && timer === undefined) connect();
      else if (isLive) {
        // The stream was there before this one watched: it hears so, and reads what it missed.
        queueMicrotask(() => {
          if (!watchers.has(watcher) || !isLive) return;
          live?.(true);
          changed();
        });
      }
      return () => {
        if (!watchers.delete(watcher) || watchers.size > 0) return;
        clearTimeout(timer);
        timer = undefined;
        source?.close();
        source = undefined;
        isLive = false;
      };
    },
  };
}
