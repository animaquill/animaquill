import type { Notification, PoolClient, QueryConfig } from "pg";
import { describeError, poolOf, type Db, type Logger } from "../database.ts";

/**
 * Hears a channel of PostgreSQL (`pg_notify`), as another process, or this one, says something on
 * it in a transaction that committed: `heard` gets each payload. On a connection of its own, which
 * it holds. One that breaks is made again after a while, and `missed` is called once it listens
 * again, as what was said meanwhile was not heard. A connection can also stop carrying anything
 * without a word, as when the network between drops it: it is asked something every `heartbeatMs`,
 * and one that does not answer in time counts as broken. Resolves to what stops it.
 */
export const listenToChannel = (
  db: Db,
  channel: string,
  hears: { heard(payload: string): void; missed(): Promise<void> },
  log: Logger,
  options: { readonly retryMs?: number; readonly heartbeatMs?: number } = {},
): { readonly ready: Promise<void>; stop(): Promise<void> } => {
  if (!/^[a-z_]+$/.test(channel)) throw new Error(`not a channel: ${channel}`);
  const retryMs = options.retryMs ?? 5000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  let stopped = false;
  let client: PoolClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });

  const heard = (message: Notification) => {
    if (message.channel !== channel || !message.payload) return;
    hears.heard(message.payload);
  };

  /** What broke, once for each connection: `which` is the connection it is about. */
  const broke = (which: PoolClient | undefined, error: unknown) => {
    if (which !== client) return;
    log.warn({ err: describeError(error), channel }, "not listening to a channel for now");
    const was = client;
    client = undefined;
    if (was) {
      was.removeListener("notification", heard);
      was.release(error instanceof Error ? error : new Error(String(error)));
    }
    if (!stopped) {
      clearTimeout(timer);
      timer = setTimeout(() => void connect(), retryMs);
      timer.unref?.();
    }
  };

  const connect = async () => {
    if (stopped) return;
    try {
      const connected = await poolOf(db).connect();
      client = connected;
      connected.on("notification", heard);
      connected.on("error", (error) => broke(connected, error));
      connected.on("end", () => broke(connected, new Error("the connection ended")));
      await connected.query(`listen ${channel}`);
      if (stopped) return;
      await hears.missed().catch((error: unknown) => {
        log.warn({ err: describeError(error), channel }, "what was missed was not caught up on");
      });
      resolveReady();
    } catch (error) {
      broke(client, error);
    }
  };
  void connect();

  const heartbeat = setInterval(() => {
    const which = client;
    if (!which) return;
    which
      .query({
        text: "select 1",
        query_timeout: Math.max(1000, heartbeatMs / 2),
      } as QueryConfig)
      .catch((error: unknown) => broke(which, error));
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    ready,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      const was = client;
      client = undefined;
      if (!was) return;
      was.removeListener("notification", heard);
      try {
        await was.query(`unlisten ${channel}`);
        was.release();
      } catch (error) {
        was.release(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
};
