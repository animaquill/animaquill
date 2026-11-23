import type { Notification, PoolClient, QueryConfig } from "pg";
import { describeError, poolOf, type Db, type Logger } from "../database.ts";
import { LINK_CHANNEL } from "../archive/links.ts";

/**
 * Hears from PostgreSQL that the link of a project to its repository changed (`LINK_CHANNEL`, see
 * archive/links.ts), as the worker, a webhook or a request changes it in whatever process, and says
 * so to the hub (`SyncHub.linkChanged`): a project whose repository cannot be used any more is not
 * edited a moment longer. On a connection of its own, which it holds. One that breaks is made again
 * after a while, and the hub reads every project it holds again then (`linksChanged`), as what was
 * said meanwhile was not heard. A connection can also stop carrying anything without a word, as
 * when the network between drops it: it is asked something every `heartbeatMs`, and one that does
 * not answer in time counts as broken. Resolves to what stops it.
 */
export const listenForLinks = (
  db: Db,
  hub: { linkChanged(id: string): Promise<void>; linksChanged(): Promise<void> },
  log: Logger,
  options: { readonly retryMs?: number; readonly heartbeatMs?: number } = {},
): { readonly ready: Promise<void>; stop(): Promise<void> } => {
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
    if (message.channel !== LINK_CHANNEL || !message.payload) return;
    void hub.linkChanged(message.payload).catch((error: unknown) => {
      log.warn(
        { err: describeError(error), project: message.payload },
        "a change of a link was not taken in",
      );
    });
  };

  /** What broke, once for each connection: `which` is the connection it is about. */
  const broke = (which: PoolClient | undefined, error: unknown) => {
    if (which !== client) return;
    log.warn({ err: describeError(error) }, "not listening to changes of links for now");
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
      await connected.query(`listen ${LINK_CHANNEL}`);
      if (stopped) return;
      // What was said while nobody listened: every project the hub holds is read again.
      await hub.linksChanged().catch((error: unknown) => {
        log.warn({ err: describeError(error) }, "links were not read again");
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
        await was.query(`unlisten ${LINK_CHANNEL}`);
        was.release();
      } catch (error) {
        was.release(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
};
