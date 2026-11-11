import { ProjectStore } from "@animaquill/core";
import {
  Reassembler,
  SYNC_CLOSE,
  SYNC_LIMITS,
  SYNC_PROTOCOL,
  framesOf,
  readSyncServerMessage,
  type CloudAccess,
} from "@animaquill/host";
import type { Downloaded } from "./download.ts";

/**
 * Makes a new project on the platform from a whole project in memory, in one connection, as
 * `download` takes one from there: the same protocol, a "hello" with `create` and the whole
 * project, see `SyncClientMessage`. What comes back is what a copy in this browser starts from,
 * see `CloudProjects.keepUploaded`: the project as the platform has it now, the number of its last
 * update there and its digest, and which working copy it is.
 *
 * Under an id the platform has already, as after a try whose answer did not come back, the platform
 * makes nothing and sends what it has: that is the project then. Nothing is made under an id that
 * the platform took away, as a try that was given up on: it says "no such project" then.
 *
 * The connection is closed whatever happens, and `closed` says once it is: whoever takes the
 * project away again after giving up waits for that, so that a hello that is still on its way
 * arrives before.
 */

/** How long the whole project may take to get there, at most. */
const UPLOAD_MS = 120_000;

/** Why a project could not be made on the platform. */
export class UploadFailed extends Error {
  override readonly name = "UploadFailed";
  /**
   * "missing": the platform would not make it, as under an id it took away. "signedOut", "tooLarge",
   * "quota", "outdated": what it said. "stopped": people stopped it. "offline": no answer, or no
   * connection at all.
   */
  readonly code:
    | "missing"
    | "signedOut"
    | "tooLarge"
    | "quota"
    | "outdated"
    | "stopped"
    | "offline"
    | "rejected";

  constructor(message: string, code: UploadFailed["code"]) {
    super(message);
    this.code = code;
  }
}

const codeOf = (close: number): UploadFailed["code"] => {
  switch (close) {
    case SYNC_CLOSE.missing:
      return "missing";
    case SYNC_CLOSE.signedOut:
    case SYNC_CLOSE.forbidden:
      return "signedOut";
    case SYNC_CLOSE.tooLarge:
      return "tooLarge";
    case SYNC_CLOSE.quota:
      return "quota";
    case SYNC_CLOSE.outdated:
      return "outdated";
    case SYNC_CLOSE.protocol:
      return "rejected";
    default:
      return "offline";
  }
};

export interface UploadRequest {
  /** The id the project gets on the platform, see `newSyncId`. */
  readonly project: string;
  /** All of it, as one update, see `ProjectStore.encodeWhole`. */
  readonly state: Uint8Array;
  /** What it is called, and its own id, as the platform keeps them, see "hello". */
  readonly create: { readonly name: string; readonly projectId: string };
  readonly window: string;
  readonly editor: string;
  readonly signal?: AbortSignal;
  /** How long it may take, in milliseconds. */
  readonly timeoutMs?: number;
}

export interface Upload {
  /** What came of it: the project on the platform, or why not. */
  readonly done: Promise<Downloaded>;
  /** Resolves once the connection is closed for good: what was sent arrived by then, or never will. */
  readonly closed: Promise<void>;
}

export function upload(cloud: CloudAccess, request: UploadRequest): Upload {
  if (request.state.length > SYNC_LIMITS.state) {
    return {
      done: Promise.reject(new UploadFailed("The project is too large", "tooLarge")),
      closed: Promise.resolve(),
    };
  }
  const connection = cloud.connect();
  const closed = connection.closed.then(
    () => {},
    () => {},
  );
  const updates: Uint8Array[] = [];
  let generation: number | undefined;
  let head = 0;
  let digest = "";
  const done = new Promise<Downloaded>((resolve, reject) => {
    let isOver = false;
    const timer = setTimeout(
      () => fail(new UploadFailed("The platform took too long", "offline")),
      request.timeoutMs ?? UPLOAD_MS,
    );
    function fail(error: Error) {
      if (isOver) return;
      isOver = true;
      clearTimeout(timer);
      connection.close(1000, "");
      reject(error);
    }
    const succeed = (result: Downloaded) => {
      if (isOver) return;
      isOver = true;
      clearTimeout(timer);
      connection.close(1000, "");
      resolve(result);
    };
    void connection.closed.then(({ code }) =>
      fail(new UploadFailed(`The platform closed the connection (${code})`, codeOf(code))),
    );
    const stop = () => fail(new UploadFailed("Stopped", "stopped"));
    if (request.signal?.aborted) {
      stop();
      return;
    }
    request.signal?.addEventListener("abort", stop, { once: true });
    const frames = new Reassembler(SYNC_LIMITS.state);
    connection.onMessage((data) => {
      const whole = frames.take(data);
      if (whole === "more") return;
      const message = whole && readSyncServerMessage(whole);
      if (!message) {
        fail(new UploadFailed("The platform said something that makes no sense", "offline"));
        return;
      }
      if (message.t === "welcome") {
        generation = message.generation;
        head = message.head;
        digest = message.digest;
      }
      if (message.t === "update") updates.push(message.payload);
      if (message.t !== "synced") return;
      // Made just now, the platform sends nothing back: it has what was sent. Made before, as by a
      // try whose answer did not come, it sends what it has, which is what was sent then.
      const { store } = ProjectStore.fromUpdates(updates.length > 0 ? updates : [request.state]);
      if (!store || store.isMissingUpdates) {
        fail(new UploadFailed("What the platform has is not a whole project", "offline"));
        return;
      }
      const state = store.encodeState();
      store.destroy();
      succeed({ state, head: message.head || head, digest: message.digest || digest, generation });
    });
    void (async () => {
      try {
        await connection.opened;
        const device = await cloud.links.device();
        if (isOver) return;
        for (const frame of framesOf({
          t: "hello",
          v: SYNC_PROTOCOL,
          project: request.project,
          after: 0,
          device,
          window: request.window,
          editor: request.editor,
          create: request.create,
          payload: request.state,
        })) {
          connection.send(frame);
        }
      } catch {
        // The connection says why once it is closed.
      }
    })();
  });
  // Nobody has to wait for it to hear why it failed.
  done.catch(() => {});
  return { done, closed };
}
