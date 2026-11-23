import type { CloudClose, CloudConnection } from "@animaquill/host/sync";
import {
  Reassembler,
  SYNC_LIMITS,
  encodeSyncMessage,
  framesOf,
  readSyncClientMessage,
  readSyncServerMessage,
  type SyncClientMessage,
  type SyncServerMessage,
} from "@animaquill/host/sync";
import { users } from "../schema.ts";
import type { Db } from "../database.ts";
import type { SyncHub, SyncWho } from "../sync/hub.ts";

/** How a test can get in the way of a connection. */
export interface LineFaults {
  /** Nothing gets through either way, as on a line that died without a word. */
  silent: boolean;
  /** This many changes that windows send arrive broken, as from an editor with a bug. */
  breaking?: number;
}

/** A change as a broken editor would send it: the platform has to turn it away. */
function broken(data: Uint8Array, faults: LineFaults): Uint8Array {
  if (!faults.breaking) return data;
  const message = readSyncClientMessage(data);
  if (message?.t !== "push") return data;
  faults.breaking -= 1;
  return encodeSyncMessage({ ...message, payload: new Uint8Array([0, 7, 7, 7, 255, 255]) });
}

/**
 * A connection of an editor to a hub in the same process, as a WebSocket carries it: each message
 * a copy of its bytes, a moment later, in order.
 */
export function hubConnection(
  hub: SyncHub,
  who: SyncWho,
  faults: LineFaults = { silent: false },
): CloudConnection & { readonly isClosed: () => boolean; drop(): void } {
  let toClient: (data: Uint8Array) => void = () => {};
  let resolveClosed: (close: CloudClose) => void = () => {};
  let isOpen = false;
  let isClosed = false;
  const closed = new Promise<CloudClose>((resolve) => {
    resolveClosed = resolve;
  });
  const later = (run: () => void) => void Promise.resolve().then(run);
  const end = (code: number, reason: string) => {
    if (isClosed) return;
    isClosed = true;
    later(() => resolveClosed({ code, reason }));
  };
  const server = hub.open(
    {
      send: (data) => {
        const copy = data.slice();
        later(() => {
          if (!isClosed && !faults.silent) toClient(copy);
        });
      },
      close: (code, reason) => end(code, reason),
    },
    who,
  );
  const opened = new Promise<void>((resolve) => {
    later(() => {
      isOpen = !isClosed;
      resolve();
    });
  });
  return {
    opened,
    closed,
    isClosed: () => isClosed,
    send: (data) => {
      const copy = broken(data.slice(), faults);
      later(() => {
        if (isOpen && !isClosed && !faults.silent) server.receive(copy);
      });
    },
    onMessage: (listener) => {
      toClient = listener;
    },
    close: () => {
      end(1000, "");
      server.closed();
    },
    /** The line goes away, as a network does: neither side says anything. */
    drop: () => {
      end(1006, "");
      server.closed();
    },
  };
}

/** A connection that a test drives message by message. */
export class TestPeer {
  readonly received: SyncServerMessage[] = [];
  readonly connection: ReturnType<typeof hubConnection>;
  closedWith: CloudClose | undefined;
  /** What waits for something to come, see `until`. */
  readonly #waiting = new Set<() => void>();

  constructor(hub: SyncHub, who: SyncWho) {
    this.connection = hubConnection(hub, who);
    const frames = new Reassembler(SYNC_LIMITS.state);
    this.connection.onMessage((data) => {
      const whole = frames.take(data);
      if (whole === "more") return;
      const message = whole && readSyncServerMessage(whole);
      if (!message) return;
      this.received.push(message);
      this.#changed();
    });
    void this.connection.closed.then((close) => {
      this.closedWith = close;
      this.#changed();
    });
  }

  #changed(): void {
    for (const check of Array.from(this.#waiting)) check();
  }

  /** A message, in as many frames as it takes. */
  send(message: SyncClientMessage): void {
    for (const frame of framesOf(message)) this.connection.send(frame);
  }

  /** Sends raw bytes, as a broken or hostile editor can. */
  sendBytes(data: Uint8Array<ArrayBuffer>): void {
    this.connection.send(data);
  }

  /** What came of the kind, in order. */
  of<T extends SyncServerMessage["t"]>(t: T): Extract<SyncServerMessage, { t: T }>[] {
    return this.received.filter((message) => message.t === t) as Extract<
      SyncServerMessage,
      { t: T }
    >[];
  }

  /**
   * Waits until what came on the connection says so: it looks again with every message and when
   * the connection closes, and fails once it closed without that. Otherwise the test's own time is
   * what it gets, which a busy machine needs: the platform answers once the database has.
   */
  until(done: () => boolean, what = "something"): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (done()) {
          this.#waiting.delete(check);
          resolve();
        } else if (this.closedWith !== undefined) {
          this.#waiting.delete(check);
          reject(new Error(`waited in vain for ${what}: the connection closed`));
        }
      };
      this.#waiting.add(check);
      check();
    });
  }
}

let people = 0;

/** Someone with an account, in the database. */
export async function someone(db: Db): Promise<SyncWho> {
  people += 1;
  const [user] = await db
    .insert(users)
    .values({ githubId: 10_000 + people + Math.floor(Math.random() * 1e9), login: `user${people}` })
    .returning({ id: users.id });
  return { userId: (user as { id: string }).id, session: `session-${people}` };
}
