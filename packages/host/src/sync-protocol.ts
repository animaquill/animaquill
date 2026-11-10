/**
 * The sync protocol between the editor and a platform, such as AnimaQuill Cloud: its messages, their
 * limits, and how they go over the line. It needs nothing but the language, so that a platform on
 * Node uses the same code, see @animaquill/host/sync.
 *
 * A frame is one binary WebSocket message: four bytes that say how long its header is, the header
 * as JSON in UTF-8, and then the payload, an update or a state vector of Yjs, or nothing. A message
 * whose payload is larger than `SYNC_LIMITS.part` goes in several frames: the first has the header
 * and says how many `parts` there are, the others only say `{"t":"more"}`, see `framesOf` and
 * `Reassembler`. So nothing waits behind one large message, and a slow line still hears something
 * now and then.
 *
 * Every update of the platform has a number, and a digest that stands for it and every update
 * before it. A window keeps both: when the platform comes back from a backup, the same number can
 * stand for another update, and the digest says so, see "welcome".
 */

/** The version of the protocol. A platform that speaks another one closes with `SYNC_CLOSE.outdated`. */
export const SYNC_PROTOCOL = 1;

/** Limits of the protocol, which the platform holds every message to. */
export const SYNC_LIMITS = {
  /** Bytes of a header. */
  header: 4096,
  /**
   * Bytes of the payload of one frame. Small enough that a slow line gets one through between two
   * heartbeats, see `CloudConnection.buffered`.
   */
  part: 256 * 1024,
  /** Bytes of a change that a window sends, in all its parts. */
  update: 16 * 1024 * 1024,
  /** Bytes of the first version of a project, and of a whole project that the platform sends. */
  state: 16 * 1024 * 1024,
  /** Pieces (structs of Yjs) in one change or in the first version of a project. */
  structs: 200_000,
} as const;

/** The largest frame there is. */
export const SYNC_MESSAGE_BYTES = SYNC_LIMITS.part + SYNC_LIMITS.header + 4;

/** Why a connection closed, as the platform says it. */
export const SYNC_CLOSE = {
  /** A message made no sense. */
  protocol: 4400,
  /** Nobody is signed in, or the session is over. */
  signedOut: 4401,
  /** Not from the editor's own site. */
  forbidden: 4403,
  /** No such project, or not one of whoever is signed in. */
  missing: 4404,
  /** The editor is too old for the platform: reload. */
  outdated: 4426,
  /** Too many connections or messages: come back later. */
  tooMany: 4429,
  /** The first version of the project is larger than the platform takes. */
  tooLarge: 4413,
  /** Whoever is signed in keeps as many projects, or bytes, on the platform as they may. */
  quota: 4507,
  /** Something went wrong on the platform. */
  failed: 4500,
  /** The platform is stopping, or its database is away: come back later. */
  unavailable: 4503,
} as const;

/**
 * Who made a change, as the platform keeps it: the person at the editor, files that changed in the
 * project folder, an AI task, something else, or what a window found that the platform did not have
 * when they compared, see the message "check". The first version of a project is "first".
 */
export type SyncKind = "user" | "folder" | "ai" | "other" | "repair";
export const SYNC_KINDS: readonly SyncKind[] = ["user", "folder", "ai", "other", "repair"];

/** Why the platform did not take an update. */
export type SyncRejection =
  /** It cannot be read. */
  | "malformed"
  /** It writes somewhere other than the project, or kinds of values the editor never writes. */
  | "foreign"
  /** It writes a key the format does not have there, or a value that is not of its field. */
  | "invalid"
  /** It needs something the platform does not have: compare and send again. */
  | "incomplete"
  /** It would make the project another one, or no project at all. */
  | "identity"
  /** It is of a newer format than the platform knows yet: try again later. */
  | "too-new"
  /** It, or the project with it, is larger than the platform keeps. */
  | "too-large"
  /** Whoever is signed in keeps more on the platform than they may. */
  | "quota"
  /** It says it comes from someone this connection cannot speak for. */
  | "source"
  /** Too much at once: try again later. */
  | "busy"
  /** The platform could not keep it right now: try again later. */
  | "unavailable";

const REJECTIONS: ReadonlySet<string> = new Set<SyncRejection>([
  "malformed",
  "foreign",
  "invalid",
  "incomplete",
  "identity",
  "too-new",
  "too-large",
  "quota",
  "source",
  "busy",
  "unavailable",
]);

export type SyncClientMessage =
  /**
   * The first message, for one project: the updates after `after` come back, then "synced". The
   * window says the digest it has for `after`, see "welcome". With `create`, the payload is the whole
   * project, which becomes the first version of a new one with this id, or which the platform
   * compares with what it has, when it has the project already.
   */
  | {
      readonly t: "hello";
      readonly v: number;
      readonly project: string;
      readonly after: number;
      readonly digest?: string;
      readonly device: string;
      readonly window: string;
      readonly editor: string;
      readonly create?: { readonly name: string; readonly projectId: string };
      readonly payload: Uint8Array;
    }
  /**
   * A change, with who made it, which update of the platform its window had then, when it made it,
   * and whether it made it without the latest of the platform, such as while offline.
   */
  | {
      readonly t: "push";
      readonly id: number;
      readonly kind: SyncKind;
      readonly base: number;
      readonly at: number;
      readonly window: string;
      readonly behind: boolean;
      readonly payload: Uint8Array;
    }
  /** Asks what the platform has, to find out what either side is missing. */
  | { readonly t: "check" }
  | { readonly t: "ping" };

export type SyncServerMessage =
  /**
   * The project is there, at `head`, whose digest is `digest`. `reset`: the platform does not have
   * what the window says it had at `after` (the platform came back from a backup, or the window
   * says it has more than there is): what came after comes from the start, and the window sends
   * again what it has of its own.
   */
  | {
      readonly t: "welcome";
      readonly head: number;
      readonly digest: string;
      readonly reset: boolean;
    }
  /** An update of the platform. "snapshot" is the whole project up to `seq`. */
  | {
      readonly t: "update";
      readonly seq: number;
      readonly digest: string;
      readonly kind: string;
      readonly at: number;
      readonly payload: Uint8Array;
    }
  /** Everything up to `head` has come, as asked for by "hello". */
  | { readonly t: "synced"; readonly head: number; readonly digest: string }
  /** A change is on the platform as this update, or was there already when `seq` is no new one. */
  | { readonly t: "ack"; readonly id: number; readonly seq: number; readonly digest: string }
  | {
      readonly t: "reject";
      readonly id: number;
      readonly reason: SyncRejection;
      /** Whether the same change can go again later. */
      readonly retry: boolean;
    }
  /**
   * What the platform has at `head`: its state vector and everything that was taken away in it,
   * see `packChecked`.
   */
  | {
      readonly t: "checked";
      readonly head: number;
      readonly digest: string;
      readonly payload: Uint8Array;
    }
  | { readonly t: "pong" };

/** A message that goes on in the next frames, see `framesOf`. */
interface Parts {
  readonly parts?: number;
}

const NONE = new Uint8Array(0);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function frame(header: object, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = encoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length + payload.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  out.set(payload, 4 + head.length);
  return out;
}

/** A message in one frame, for what has no payload or a small one. */
export function encodeSyncMessage(
  message: SyncClientMessage | SyncServerMessage,
): Uint8Array<ArrayBuffer> {
  const [only, ...more] = framesOf(message);
  if (!only || more.length > 0) throw new Error("This message needs more than one frame");
  return only;
}

/** A message as the frames that carry it, in order. */
export function framesOf(
  message: SyncClientMessage | SyncServerMessage,
  part: number = SYNC_LIMITS.part,
): Uint8Array<ArrayBuffer>[] {
  const { payload = NONE, ...header } = message as { payload?: Uint8Array };
  if (payload.length <= part) return [frame(header, payload)];
  const parts = Math.ceil(payload.length / part);
  const frames = [frame({ ...header, parts }, payload.subarray(0, part))];
  for (let at = part; at < payload.length; at += part) {
    frames.push(frame({ t: "more" }, payload.subarray(at, at + part)));
  }
  return frames;
}

/** The header and the payload of a frame, or undefined when it is none. */
function split(
  data: Uint8Array,
): { readonly header: Record<string, unknown>; readonly payload: Uint8Array } | undefined {
  if (data.length < 4) return undefined;
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
  if (length > SYNC_LIMITS.header || 4 + length > data.length) return undefined;
  let header: unknown;
  try {
    header = JSON.parse(decoder.decode(data.subarray(4, 4 + length)));
  } catch {
    return undefined;
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) return undefined;
  return { header: header as Record<string, unknown>, payload: data.subarray(4 + length) };
}

/** Puts back together a message that came in several frames, see `framesOf`. */
export class Reassembler {
  readonly #most: number;
  #header: Record<string, unknown> | undefined;
  #pieces: Uint8Array[] = [];
  #left = 0;
  #bytes = 0;

  /** `most`: how many bytes a whole payload may have. */
  constructor(most: number) {
    this.#most = most;
  }

  /** Whether a message is on its way, so that the next frames are its parts. */
  get isWaiting(): boolean {
    return this.#header !== undefined;
  }

  /** Bytes it holds of a message that is on its way. */
  get held(): number {
    return this.#header === undefined ? 0 : this.#bytes;
  }

  /** Whether the last frame that was no part of the protocol said a message larger than `most`. */
  tooLarge = false;

  /**
   * A frame. Resolves to the whole message once it has all of it, "more" while it waits for parts,
   * and undefined for what is no frame of the protocol, or parts that do not add up.
   */
  take(
    data: Uint8Array,
  ):
    | { readonly header: Record<string, unknown>; readonly payload: Uint8Array }
    | "more"
    | undefined {
    this.tooLarge = false;
    const parts = split(data);
    if (!parts) return undefined;
    const { header, payload } = parts;
    if (this.#header) {
      if (header["t"] !== "more" || payload.length > SYNC_LIMITS.part) return undefined;
      this.#bytes += payload.length;
      if (this.#bytes > this.#most) {
        this.tooLarge = true;
        return undefined;
      }
      this.#pieces.push(payload.slice());
      this.#left -= 1;
      if (this.#left > 0) return "more";
      const whole = new Uint8Array(this.#bytes);
      let at = 0;
      for (const piece of this.#pieces) {
        whole.set(piece, at);
        at += piece.length;
      }
      const first = this.#header;
      this.#header = undefined;
      this.#pieces = [];
      return { header: first, payload: whole };
    }
    const count = header["parts"];
    if (count === undefined) return header["t"] === "more" ? undefined : parts;
    if (
      typeof count !== "number" ||
      !Number.isSafeInteger(count) ||
      count < 2 ||
      payload.length > SYNC_LIMITS.part
    )
      return undefined;
    if (count > Math.ceil(this.#most / SYNC_LIMITS.part) + 1) {
      this.tooLarge = true;
      return undefined;
    }
    const { parts: _parts, ...rest } = header as Parts & Record<string, unknown>;
    this.#header = rest;
    this.#pieces = [payload.slice()];
    this.#bytes = payload.length;
    this.#left = count - 1;
    return "more";
  }
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
/** What names a device, a window or a project of the platform. */
const isToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const isText = (value: unknown, longest: number): value is string =>
  typeof value === "string" && value.length <= longest;
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(value);

type Parsed = { readonly header: Record<string, unknown>; readonly payload: Uint8Array };

/** A message from a window, from a whole message (see `Reassembler`), or undefined when it is none. */
export function readSyncClientMessage(data: Uint8Array | Parsed): SyncClientMessage | undefined {
  const parts = data instanceof Uint8Array ? split(data) : data;
  if (!parts || (data instanceof Uint8Array && parts.header["parts"] !== undefined))
    return undefined;
  const { header: h, payload } = parts;
  switch (h["t"]) {
    case "hello": {
      const create = h["create"] as Record<string, unknown> | undefined;
      const isCreate =
        create === undefined ||
        (typeof create === "object" &&
          create !== null &&
          isText(create["name"], 200) &&
          isText(create["projectId"], 64));
      if (
        !isCount(h["v"]) ||
        !isToken(h["project"]) ||
        !isCount(h["after"]) ||
        (h["digest"] !== undefined && !isDigest(h["digest"])) ||
        !isToken(h["device"]) ||
        !isToken(h["window"]) ||
        !isText(h["editor"], 64) ||
        !isCreate
      )
        return undefined;
      return {
        t: "hello",
        v: h["v"],
        project: h["project"],
        after: h["after"],
        ...(typeof h["digest"] === "string" && { digest: h["digest"] }),
        device: h["device"],
        window: h["window"],
        editor: h["editor"],
        ...(create && {
          create: { name: create["name"] as string, projectId: create["projectId"] as string },
        }),
        payload,
      };
    }
    case "push": {
      const kind = h["kind"];
      if (
        !isCount(h["id"]) ||
        typeof kind !== "string" ||
        !(SYNC_KINDS as readonly string[]).includes(kind) ||
        !isCount(h["base"]) ||
        !isTime(h["at"]) ||
        !isToken(h["window"]) ||
        typeof h["behind"] !== "boolean"
      )
        return undefined;
      return {
        t: "push",
        id: h["id"],
        kind: kind as SyncKind,
        base: h["base"],
        at: h["at"],
        window: h["window"],
        behind: h["behind"],
        payload,
      };
    }
    case "check":
      return { t: "check" };
    case "ping":
      return { t: "ping" };
    default:
      return undefined;
  }
}

/** A message from the platform, from a whole message (see `Reassembler`), or undefined. */
export function readSyncServerMessage(data: Uint8Array | Parsed): SyncServerMessage | undefined {
  const parts = data instanceof Uint8Array ? split(data) : data;
  if (!parts || (data instanceof Uint8Array && parts.header["parts"] !== undefined))
    return undefined;
  const { header: h, payload } = parts;
  switch (h["t"]) {
    case "welcome":
      if (!isCount(h["head"]) || !isDigest(h["digest"]) || typeof h["reset"] !== "boolean")
        return undefined;
      return { t: "welcome", head: h["head"], digest: h["digest"], reset: h["reset"] };
    case "update":
      if (
        !isCount(h["seq"]) ||
        !isDigest(h["digest"]) ||
        !isText(h["kind"], 32) ||
        !isTime(h["at"])
      )
        return undefined;
      return {
        t: "update",
        seq: h["seq"],
        digest: h["digest"],
        kind: h["kind"],
        at: h["at"],
        payload,
      };
    case "synced":
      if (!isCount(h["head"]) || !isDigest(h["digest"])) return undefined;
      return { t: "synced", head: h["head"], digest: h["digest"] };
    case "ack":
      if (!isCount(h["id"]) || !isCount(h["seq"]) || !isDigest(h["digest"])) return undefined;
      return { t: "ack", id: h["id"], seq: h["seq"], digest: h["digest"] };
    case "reject": {
      const reason = h["reason"];
      if (!isCount(h["id"]) || typeof reason !== "string" || typeof h["retry"] !== "boolean")
        return undefined;
      return {
        t: "reject",
        id: h["id"],
        // A reason of a newer platform is one this editor cannot do anything about.
        reason: REJECTIONS.has(reason) ? (reason as SyncRejection) : "malformed",
        retry: h["retry"],
      };
    }
    case "checked":
      if (!isCount(h["head"]) || !isDigest(h["digest"])) return undefined;
      return { t: "checked", head: h["head"], digest: h["digest"], payload };
    case "pong":
      return { t: "pong" };
    default:
      return undefined;
  }
}

/** What "checked" carries: the state vector of the platform, and what was taken away there. */
export function packChecked(stateVector: Uint8Array, deletions: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + stateVector.length + deletions.length);
  new DataView(out.buffer).setUint32(0, stateVector.length);
  out.set(stateVector, 4);
  out.set(deletions, 4 + stateVector.length);
  return out;
}

export function unpackChecked(
  payload: Uint8Array,
): { readonly stateVector: Uint8Array; readonly deletions: Uint8Array } | undefined {
  if (payload.length < 4) return undefined;
  const length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0);
  if (4 + length > payload.length) return undefined;
  return {
    stateVector: payload.subarray(4, 4 + length),
    deletions: payload.subarray(4 + length),
  };
}

/** A new id for a device, a window or a project of the platform: 128 random bits. */
export const newSyncId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let text = "";
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0");
  return text;
};

/** A connection to the platform, which carries frames, see `SyncClientMessage`. */
export interface CloudConnection {
  /** Resolves once it is open. Rejects when it never was. */
  readonly opened: Promise<void>;
  /** Resolves once it is closed, for whatever reason. */
  readonly closed: Promise<CloudClose>;
  /** Sends a frame, or nothing when it is not open. */
  send(data: Uint8Array<ArrayBuffer>): void;
  /** Hears every frame, in order. One listener at a time. */
  onMessage(listener: (data: Uint8Array) => void): void;
  close(code?: number, reason?: string): void;
  /**
   * Bytes sent that are still on their way out, as a WebSocket's `bufferedAmount`: where that gets
   * less, the line is there, however long a large change takes. Not every connection knows.
   */
  buffered?(): number;
}

/** Why a connection closed: a WebSocket's code, such as one of `SYNC_CLOSE`, and its reason. */
export interface CloudClose {
  readonly code: number;
  readonly reason: string;
}
