import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import type { LfsAction, LfsObject } from "../archive/repo-host.ts";

/**
 * What the large file storage's own addresses are asked, once its batch API gave them (Git LFS's
 * basic transfers): one PUT of the whole file, and a POST that says it is there. Nothing here logs,
 * and errors name neither the address nor its headers, which carry credentials of their own.
 *
 * What is sent is hashed on its way out (`Checked`), and its last piece only goes once all of it
 * turned out to be the object it is sent as: anything else stops short of its length, which no
 * storage takes for a file.
 */

const LFS_MEDIA = "application/vnd.git-lfs+json";
const MINUTE = 60_000;

/** The storage did not take what was sent, or could not be reached. Tried again later. */
export class TransferFailed extends Error {
  override name = "TransferFailed";
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/**
 * How long sending a file may take before it is given up, and tried again later: 15 minutes, or as
 * long as it takes at 512 KiB/s, so that a slow line still gets there and a hung one lets go.
 */
export const transferMs = (size: number): number =>
  Math.max(15 * MINUTE, Math.ceil((size / (512 * 1024)) * 1000));

/** What was to be sent is not the object it was to be sent as: nothing of it is in the storage. */
export class NotTheObject extends Error {
  override name = "NotTheObject";
}

/**
 * A file on its way out, hashed as it goes: everything passes but its last piece, which is held
 * back until the file has ended and its SHA-256 and length are those of the object (`oid`, in
 * lower-case hexadecimal, and `size`). Only then does the last piece go, and the stream end. A file
 * that is anything else fails with `NotTheObject`, short of its length: read once, so that what is
 * hashed is what is sent, whatever becomes of the file meanwhile.
 */
export class Checked extends Transform {
  readonly #oid: string;
  readonly #size: number;
  readonly #hash = createHash("sha256");
  #held: Buffer | undefined;
  #bytes = 0;
  /** Whether the file ended as something else than the object. */
  mismatch = false;

  constructor(object: LfsObject) {
    super();
    this.#oid = object.oid;
    this.#size = object.size;
  }

  override _transform(piece: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.#hash.update(piece);
    this.#bytes += piece.length;
    const before = this.#held;
    this.#held = piece;
    if (before) this.push(before);
    done();
  }

  override _flush(done: TransformCallback): void {
    if (this.#bytes !== this.#size || this.#hash.digest("hex") !== this.#oid) {
      this.mismatch = true;
      this.#held = undefined;
      done(new NotTheObject("the file is not the object it was to be sent as"));
      return;
    }
    if (this.#held) this.push(this.#held);
    this.#held = undefined;
    done();
  }
}

export interface TransferOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Waits for the rest of an answer, which nothing reads, so that its connection can go on. */
const drain = async (response: Response) => {
  await response.arrayBuffer().catch(() => undefined);
};

/**
 * Sends a file to where an upload action says: all of it in one PUT, with its length, and the
 * headers of the action (which say what it is, where they do). `content` is read once, and has to
 * be the object: where it is not, the PUT stops before its last piece, so that the storage has
 * nothing, and this rejects with `NotTheObject`. `content` is closed whatever happens.
 */
export async function putObject(
  action: LfsAction,
  content: Readable,
  object: LfsObject,
  options: TransferOptions = {},
): Promise<void> {
  const headers = new Headers(action.header);
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  headers.set("content-length", String(object.size));
  const checked = new Checked(object);
  // What fails on either side ends both: the file is closed, and the PUT stops.
  content.on("error", (error) => checked.destroy(error));
  checked.on("error", () => content.destroy());
  checked.on("close", () => content.destroy());
  content.pipe(checked);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(action.href, {
      method: "PUT",
      headers,
      body: Readable.toWeb(checked) as ReadableStream<Uint8Array>,
      // A body that streams goes one way, as fetch of Node wants it said.
      duplex: "half",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? transferMs(object.size)),
    } as RequestInit);
  } catch (error) {
    checked.destroy();
    content.destroy();
    if (checked.mismatch) throw new NotTheObject("the file is not the object it was to be sent as");
    throw new TransferFailed(
      `sending the file failed: ${error instanceof Error ? error.name : "failed"}`,
    );
  }
  await drain(response);
  checked.destroy();
  content.destroy();
  // Whatever an answer said to a file that stopped short: it is not there.
  if (checked.mismatch) throw new NotTheObject("the file is not the object it was to be sent as");
  if (!response.ok)
    throw new TransferFailed(
      `the storage did not take the file: ${response.status}`,
      response.status,
    );
}

/** Says to the storage that an object is there, where the upload came with a verify action. */
export async function verifyObject(
  action: LfsAction,
  object: LfsObject,
  options: TransferOptions = {},
): Promise<void> {
  const headers = new Headers(action.header);
  headers.set("accept", LFS_MEDIA);
  headers.set("content-type", LFS_MEDIA);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(action.href, {
      method: "POST",
      headers,
      body: JSON.stringify({ oid: object.oid, size: object.size }),
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? MINUTE),
    });
  } catch (error) {
    throw new TransferFailed(
      `confirming the file failed: ${error instanceof Error ? error.name : "failed"}`,
    );
  }
  await drain(response);
  if (!response.ok)
    throw new TransferFailed(
      `the storage did not confirm the file: ${response.status}`,
      response.status,
    );
}
