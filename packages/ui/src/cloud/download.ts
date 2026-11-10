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

  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/**
 * All of a project on the platform, as one update, and the number of its last update there: what
 * opening it in this browser starts from. The same protocol as syncing, from nothing.
 */
export async function download(
  cloud: CloudAccess,
  project: string,
  who: { readonly window: string; readonly editor: string; readonly signal?: AbortSignal },
): Promise<{ readonly state: Uint8Array; readonly head: number }> {
  const connection = cloud.connect();
  const updates: Uint8Array[] = [];
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
      void connection.closed.then(({ code }) =>
        fail(new DownloadFailed("The platform closed the connection", code)),
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
        if (message.t === "update") updates.push(message.payload);
        if (message.t !== "synced") return;
        const { store } = ProjectStore.fromUpdates(updates);
        if (!store || store.isMissingUpdates) {
          fail(new DownloadFailed("What came is not a whole project"));
          return;
        }
        clearTimeout(timer);
        resolve({ state: store.encodeState(), head: message.head });
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
