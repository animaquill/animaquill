import { ProjectStore } from "@animaquill/core";
import {
  Reassembler,
  SYNC_LIMITS,
  SYNC_PROTOCOL,
  encodeSyncMessage,
  readSyncServerMessage,
  type CloudAccess,
} from "@animaquill/host";

/** How long the whole project may take to come, at most. */
const DOWNLOAD_MS = 120_000;

/** Why a project could not come from the platform. */
export class DownloadFailed extends Error {
  override readonly name = "DownloadFailed";
  /** How the platform closed the connection, when it did. */
  readonly code: number | undefined;
  /** ...and why, in its words, as "released" for a project it has nothing of any more. */
  readonly reason: string;

  constructor(message: string, code?: number, reason = "") {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

/** A project as it came from the platform, see `download`. */
export interface Downloaded {
  /** All of it, as one update. */
  readonly state: Uint8Array;
  /** The number of its last update there, and what the platform said stands for all up to it. */
  readonly head: number;
  readonly digest: string;
  /** Which working copy of the platform this is, where the platform says, see `CloudLink.generation`. */
  readonly generation: number | undefined;
}

/**
 * All of a project on the platform, as one update, with the number of its last update there and
 * its digest: what opening it in this browser starts from, and where syncing goes on from. The
 * same protocol as syncing, from nothing: it says no `generation`, as it has none. `readOnly`:
 * only to keep a copy of what the platform has, as one that is saved elsewhere, also of a project
 * that cannot be edited: it does not count as opening it, see `SyncClientMessage`.
 */
export async function download(
  cloud: CloudAccess,
  project: string,
  who: {
    readonly window: string;
    readonly editor: string;
    readonly signal?: AbortSignal;
    readonly readOnly?: boolean;
    /**
     * With `readOnly`: the working copy as it began, from the archive the platform made it again
     * from, see `base` of "hello": what a copy of the one before has in common with it.
     */
    readonly base?: boolean;
  },
): Promise<Downloaded> {
  const connection = cloud.connect();
  const updates: Uint8Array[] = [];
  let generation: number | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new DownloadFailed("The project took too long to come")),
        DOWNLOAD_MS,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      void connection.closed.then(({ code, reason }) =>
        fail(new DownloadFailed("The platform closed the connection", code, reason)),
      );
      // People can stop it: the connection goes, and so does what came.
      who.signal?.addEventListener("abort", () => {
        fail(new DownloadFailed("Stopped"));
        connection.close(1000, "");
      });
      const frames = new Reassembler(SYNC_LIMITS.state);
      connection.onMessage((data) => {
        const whole = frames.take(data);
        if (whole === "more") return;
        const message = whole && readSyncServerMessage(whole);
        if (!message) {
          fail(new DownloadFailed("The platform said something that makes no sense"));
          return;
        }
        if (message.t === "welcome") generation = message.generation;
        if (message.t === "update") updates.push(message.payload);
        if (message.t !== "synced") return;
        const { store } = ProjectStore.fromUpdates(updates);
        if (!store || store.isMissingUpdates) {
          fail(new DownloadFailed("What came is not a whole project"));
          return;
        }
        clearTimeout(timer);
        resolve({
          state: store.encodeState(),
          head: message.head,
          digest: message.digest,
          generation,
        });
        store.destroy();
      });
      void (async () => {
        try {
          await connection.opened;
          const device = await cloud.links.device();
          connection.send(
            encodeSyncMessage({
              t: "hello",
              v: SYNC_PROTOCOL,
              project,
              after: 0,
              device,
              window: who.window,
              editor: who.editor,
              ...(who.readOnly === true && { readOnly: true }),
              ...(who.readOnly === true && who.base === true && { base: true }),
              payload: new Uint8Array(0),
            }),
          );
        } catch {
          // The connection says why once it is closed.
        }
      })();
    });
  } finally {
    connection.close(1000, "");
  }
}
