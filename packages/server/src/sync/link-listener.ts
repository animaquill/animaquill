import { describeError, type Db, type Logger } from "../database.ts";
import { LINK_CHANNEL } from "../archive/links.ts";
import { listenToChannel } from "./channel-listener.ts";

/**
 * Hears from PostgreSQL that the link of a project to its repository changed (`LINK_CHANNEL`, see
 * archive/links.ts), as the worker, a webhook or a request changes it in whatever process, and says
 * so to the hub (`SyncHub.linkChanged`): a project whose repository cannot be used any more is not
 * edited a moment longer. Where the connection broke for a while, the hub reads every project it
 * holds again (`linksChanged`), as what was said meanwhile was not heard. See `listenToChannel`.
 */
export const listenForLinks = (
  db: Db,
  hub: { linkChanged(id: string): Promise<void>; linksChanged(): Promise<void> },
  log: Logger,
  options: { readonly retryMs?: number; readonly heartbeatMs?: number } = {},
): { readonly ready: Promise<void>; stop(): Promise<void> } =>
  listenToChannel(
    db,
    LINK_CHANNEL,
    {
      heard: (project) => {
        void hub.linkChanged(project).catch((error: unknown) => {
          log.warn({ err: describeError(error), project }, "a change of a link was not taken in");
        });
      },
      missed: () => hub.linksChanged(),
    },
    log,
    options,
  );
