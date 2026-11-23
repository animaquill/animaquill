/**
 * What changed of the person's list of projects, as the platform says it at once (`GET
 * /api/me/events` of the server, Server-Sent Events): a project renamed, made or taken away, or
 * organised otherwise, on any computer. `changed` is told each time, and once more as the stream
 * comes (again), for what was missed meanwhile; what it does is read the list again. `live` says
 * whether the stream is there: where it is not, the caller reads the list again by itself now and
 * then. A stream the browser gave up on (the platform said no, as for someone signed out, or too
 * many) is tried again after `againMs`; one that only broke, the browser tries again by itself.
 */
export interface PersonEventsAccess {
  watch(changed: () => void, live?: (live: boolean) => void): () => void;
}

/** What of `EventSource` this needs: a browser's, or one of a test. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: () => void): void;
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

export function browserPersonEvents(options: BrowserPersonEventsOptions): PersonEventsAccess {
  const open = options.open ?? ((url) => new EventSource(url) as EventSourceLike);
  const againMs = options.againMs ?? 60_000;
  return {
    watch(changed, live) {
      let stopped = false;
      let source: EventSourceLike | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let isLive = false;
      const say = (now: boolean) => {
        if (now === isLive) return;
        isLive = now;
        live?.(now);
      };
      const connect = () => {
        if (stopped) return;
        const opened = open(options.url);
        source = opened;
        opened.addEventListener("ready", () => {
          if (source !== opened) return;
          say(true);
          changed();
        });
        opened.addEventListener("message", () => {
          if (source === opened) changed();
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
      connect();
      return () => {
        stopped = true;
        clearTimeout(timer);
        source?.close();
        source = undefined;
      };
    },
  };
}
