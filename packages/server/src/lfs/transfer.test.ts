import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Staging } from "./staging.ts";
import { Checked, NotTheObject, TransferFailed, putObject } from "./transfer.ts";

/**
 * What goes to the addresses the large file storage gives out, over real connections: a file is
 * hashed as it is sent, and only one that is the object it is sent as gets there whole. Anything
 * else stops before its last piece, so that the storage, which was told its length, has no file.
 */

const MIB = 1024 * 1024;
const ID = "0190a6b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b";
const oidOf = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** What a storage got of a PUT: the bytes, and whether the request came to its end. */
interface Got {
  bytes: number;
  whole: boolean;
  hash: string | undefined;
}

const servers: Server[] = [];
const folders: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    server.close();
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A storage that takes what is put there, or answers as `handle` says. */
const storage = async (handle?: (request: IncomingMessage, response: ServerResponse) => void) => {
  const got: Got = { bytes: 0, whole: false, hash: undefined };
  const server = createServer((request, response) => {
    if (handle) return handle(request, response);
    const hash = createHash("sha256");
    request.on("data", (piece: Buffer) => {
      got.bytes += piece.length;
      hash.update(piece);
    });
    request.on("end", () => {
      got.whole = true;
      got.hash = hash.digest("hex");
      response.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const href = `http://127.0.0.1:${(server.address() as AddressInfo).port}/object`;
  return { got, action: { href, header: { "x-credential": "of the address" } } };
};

/** A file of the staging folder with these bytes, and what reads it as a push does. */
const staged = (data: Buffer) => {
  const dir = mkdtempSync(join(tmpdir(), "aq-transfer-"));
  folders.push(dir);
  const staging = new Staging(dir);
  writeFileSync(staging.pathOf(ID), data);
  return staging;
};

const fds = () => readdirSync("/proc/self/fd").length;

describe("a file on its way into the storage", () => {
  test("goes whole, with its length, where it is the object it is sent as", async () => {
    const data = randomBytes(2 * MIB + 4321);
    const { got, action } = await storage();
    const staging = staged(data);
    await putObject(action, await staging.reader(ID, data.length), {
      oid: oidOf(data),
      size: data.length,
    });
    expect(got).toEqual({ bytes: data.length, whole: true, hash: oidOf(data) });
  });

  test("stops before its last piece where it is not the object: the storage gets less than its length, and no file", async () => {
    const data = randomBytes(2 * MIB + 4321);
    for (const what of ["other bytes", "one bit", "small"] as const) {
      const there =
        what === "other bytes"
          ? randomBytes(data.length)
          : what === "small"
            ? randomBytes(700)
            : Buffer.from(data);
      // The last byte of all: everything before it is the file.
      if (what === "one bit")
        there.writeUInt8(there.readUInt8(there.length - 1) ^ 1, there.length - 1);
      const object =
        what === "small"
          ? { oid: oidOf(randomBytes(700)), size: 700 }
          : { oid: oidOf(data), size: data.length };
      const { got, action } = await storage();
      const staging = staged(there);
      const open = fds();
      await expect(
        putObject(action, await staging.reader(ID, object.size), object),
        what,
      ).rejects.toBeInstanceOf(NotTheObject);
      await vi.waitFor(() => expect(fds(), what).toBeLessThanOrEqual(open));
      // The request broke off: never its end, and never all of its bytes, however many of those
      // before the last piece the storage got to read.
      expect(got.whole, what).toBe(false);
      expect(got.bytes, what).toBeLessThan(object.size);
    }
  });

  test("is closed where the storage says no before it is all there, and that is tried again later", async () => {
    const data = randomBytes(8 * MIB);
    const { action } = await storage((request, response) => {
      response.writeHead(403, { connection: "close" });
      response.end("Request has expired");
      request.resume();
    });
    const staging = staged(data);
    const open = fds();
    const failed = await putObject(action, await staging.reader(ID, data.length), {
      oid: oidOf(data),
      size: data.length,
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(TransferFailed);
    expect(failed).not.toBeInstanceOf(NotTheObject);
    await vi.waitFor(() => expect(fds()).toBeLessThanOrEqual(open));
  });
});

describe("what is hashed on its way out", () => {
  const through = async (pieces: Buffer[], object: { oid: string; size: number }) => {
    const checked = new Checked(object);
    const out: Buffer[] = [];
    const ended = new Promise<Error | undefined>((resolve) => {
      checked.on("data", (piece: Buffer) => out.push(piece));
      checked.on("end", () => resolve(undefined));
      checked.on("error", resolve);
    });
    Readable.from(pieces).pipe(checked);
    return { error: await ended, out, checked };
  };

  test("passes everything, in order, once the end is that of the object", async () => {
    const pieces = [randomBytes(1000), randomBytes(10), randomBytes(5000)];
    const all = Buffer.concat(pieces);
    const { error, out, checked } = await through(pieces, { oid: oidOf(all), size: all.length });
    expect(error).toBeUndefined();
    expect(Buffer.concat(out)).toEqual(all);
    expect(checked.mismatch).toBe(false);
  });

  test("keeps the last piece to itself where it is not: of another hash, shorter, or longer", async () => {
    const pieces = [randomBytes(1000), randomBytes(10), randomBytes(5000)];
    const all = Buffer.concat(pieces);
    for (const object of [
      { oid: oidOf(randomBytes(10)), size: all.length },
      { oid: oidOf(all), size: all.length + 1 },
      { oid: oidOf(all), size: all.length - 1 },
    ]) {
      const { error, out, checked } = await through(pieces, object);
      expect(error).toBeInstanceOf(NotTheObject);
      expect(Buffer.concat(out)).toEqual(Buffer.concat(pieces.slice(0, 2)));
      expect(checked.mismatch).toBe(true);
    }
    // One piece, or none at all: nothing gets out.
    const one = await through([all], { oid: oidOf(randomBytes(10)), size: all.length });
    expect(one.out).toEqual([]);
    const none = await through([], { oid: oidOf(all), size: all.length });
    expect(none.error).toBeInstanceOf(NotTheObject);
  });
});
