import { randomUUID } from "node:crypto";
import { connect, type AddressInfo, type Socket } from "node:net";
import Fastify from "fastify";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Accounts, SignedIn } from "../auth/accounts.ts";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { REQUEST_HEADER } from "../auth/guard.ts";
import { randomToken } from "../seal.ts";
import { lfsRoutes, type LfsRoutesOptions } from "./routes.ts";
import type { LfsUploads, UploadAnswer } from "./uploads.ts";
import { HOSTED_CREDENTIALS } from "../auth/credentials.ts";

/**
 * What the routes of uploads into Git LFS keep from the API before a piece is read: requests from
 * elsewhere, nobody signed in, more pieces in memory at once than it holds, of everybody and of one
 * person, and pieces that do not keep coming. And that a place is let go however a request ends,
 * over real connections, as the hooks of Fastify do not hear of every end. Without a database: what
 * the uploads do is in uploads.test.ts.
 */

const ORIGIN = "https://editor.example.com";
const ID = randomUUID();
/** The largest piece of these tests. */
const CHUNK = 1024;

const person = (login: string): SignedIn => ({
  userId: randomUUID(),
  kind: "github",
  githubId: 1,
  login,
  avatarUrl: null,
  installed: true,
  renewed: false,
  expiresAt: new Date(Date.now() + 3600_000),
  createdAt: new Date(),
});

const answer: UploadAnswer = {
  id: ID,
  state: "receiving",
  repo: "1",
  oid: "a".repeat(64),
  size: 100,
  received: 10,
  chunk: CHUNK,
  minChunk: 1,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** Routes whose uploads hold each piece until the test lets it go, for people by their cookies. */
const routes = async (options: Partial<LfsRoutesOptions> = {}) => {
  const waiting: { readonly piece: Buffer; readonly go: (fail?: boolean) => void }[] = [];
  const looked = vi.fn();
  const uploads = {
    chunkBytes: CHUNK,
    expecting: async () => undefined,
    send: (_user: SignedIn, _id: string, _offset: number, piece: Buffer) =>
      new Promise<UploadAnswer>((resolve, reject) =>
        waiting.push({
          piece,
          go: (fail = false) => (fail ? reject(new Error("the disk")) : resolve(answer)),
        }),
      ),
  } as unknown as LfsUploads;
  /** Who is signed in, by the session of their cookie. */
  const people = new Map<string, SignedIn>();
  const signIn = (login = "octo") => {
    const session = randomToken();
    people.set(session, person(login));
    return `${SESSION_COOKIE}=${session}`;
  };
  const accounts = {
    session: async (session: string) => {
      looked();
      // As the database takes a moment.
      await sleep(5);
      return people.get(session);
    },
  } as unknown as Accounts;
  /** What the routes said: places taken now, and how often they were done asking who sends. */
  const seen = { taken: 0, mostTaken: 0, asked: 0, paced: 0 };
  const app = Fastify({ requestTimeout: 60_000 });
  apps.push(app);
  // As the API has one (app.ts): with it, an answer is not out when it is sent, but a moment later.
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  await app.register(lfsRoutes, {
    origin: ORIGIN,
    accounts: () => accounts,
    credentials: HOSTED_CREDENTIALS,
    uploads: () => uploads,
    // The pieces of uploads, which name no project: nothing to check.
    gate: async () => true,
    watch: {
      places: (taken) => {
        seen.taken = taken;
        seen.mostTaken = Math.max(seen.mostTaken, taken);
      },
      asked: () => void (seen.asked += 1),
      paced: () => void (seen.paced += 1),
    },
    ...options,
  });
  /** Until the server has no connection open any more: those of `open` are all it has. */
  const noConnections = () =>
    vi.waitFor(async () => {
      const count = await new Promise<number>((resolve, reject) =>
        app.server.getConnections((error, value) => (error ? reject(error) : resolve(value))),
      );
      expect(count).toBe(0);
    });
  /** Until how fast a piece comes was looked at twice more: once at least since now. */
  const paced = async () => {
    const from = seen.paced;
    await vi.waitFor(() => expect(seen.paced).toBeGreaterThanOrEqual(from + 2));
  };
  const cookie = signIn();
  const headersOf = (more: Record<string, string> = {}) => ({
    cookie,
    origin: ORIGIN,
    [REQUEST_HEADER]: "1",
    "content-type": "application/octet-stream",
    "upload-offset": "10",
    ...more,
  });
  const put = (headers: Record<string, string> = {}, payload: Buffer = Buffer.alloc(10)) =>
    app.inject({
      method: "PUT",
      url: `/api/lfs/uploads/${ID}`,
      headers: headersOf(headers),
      payload,
    });

  /** The same over a real connection, which a test can leave, or send a piece slowly on. */
  let port: number | undefined;
  const open = async (
    length: number | undefined,
    headers: Record<string, string> = {},
  ): Promise<{ socket: Socket; answer: () => string; status: () => number | undefined }> => {
    if (port === undefined) {
      await app.listen({ port: 0, host: "127.0.0.1" });
      port = (app.server.address() as AddressInfo).port;
    }
    const socket = connect(port, "127.0.0.1");
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    let got = "";
    socket.on("data", (data) => (got += data.toString("latin1")));
    socket.on("error", () => {});
    const lines = Object.entries({
      host: "127.0.0.1",
      ...headersOf(headers),
      ...(length === undefined
        ? { "transfer-encoding": "chunked" }
        : { "content-length": String(length) }),
    }).map(([name, value]) => `${name}: ${value}`);
    socket.write(`PUT /api/lfs/uploads/${ID} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    return {
      socket,
      answer: () => got,
      status: () => {
        const status = /^HTTP\/1\.1 (\d{3})/.exec(got)?.[1];
        return status === undefined ? undefined : Number(status);
      },
    };
  };
  return { app, put, open, signIn, waiting, looked, seen, noConnections, paced };
};

describe("pieces of files on their way into Git LFS", () => {
  test("only so many are held in memory at once: the rest come back in a moment, and each lets go once answered", async () => {
    const { put, waiting } = await routes({ piecesAtOnce: 2, piecesPerPerson: 5 });
    const first = put();
    const second = put();
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    const third = await put();
    expect(third.statusCode).toBe(503);
    expect(third.json()).toEqual({ error: "busy" });
    expect(third.headers["retry-after"]).toBe("2");
    waiting.shift()!.go();
    expect((await first).statusCode).toBe(200);
    expect((await first).json()).toEqual(answer);
    expect((await first).headers["upload-offset"]).toBe("10");
    // One that fails lets go as well.
    const fourth = put();
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    waiting.shift()!.go(true);
    expect((await second).statusCode).toBe(503);
    expect((await second).json()).toEqual({ error: "unavailable" });
    waiting.shift()!.go();
    expect((await fourth).statusCode).toBe(200);
    const fifth = put();
    const sixth = put();
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    for (const each of waiting.splice(0)) each.go();
    expect((await fifth).statusCode).toBe(200);
    expect((await sixth).statusCode).toBe(200);
  });

  test("one person has only so many at once, and does not take the places of everybody", async () => {
    const { put, signIn, waiting } = await routes({ piecesAtOnce: 4, piecesPerPerson: 2 });
    const mine = [put(), put()];
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    const third = await put();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toEqual({ error: "busy" });
    expect(third.headers["retry-after"]).toBe("2");
    // Someone else still gets in, up to what everybody has.
    const other = signIn("mona");
    const theirs = [put({ cookie: other }), put({ cookie: other })];
    await vi.waitFor(() => expect(waiting).toHaveLength(4));
    const full = await put({ cookie: signIn("hubot") });
    expect(full.statusCode).toBe(503);
    expect(full.headers["retry-after"]).toBe("2");
    // One of mine answered, one more of mine goes.
    waiting.shift()!.go();
    expect((await mine[0])!.statusCode).toBe(200);
    const again = put();
    await vi.waitFor(() => expect(waiting).toHaveLength(4));
    for (const each of waiting.splice(0)) each.go();
    for (const each of [mine[1], ...theirs, again]) expect((await each)!.statusCode).toBe(200);
  });

  test("turns away what comes from elsewhere, or from nobody, before reading a byte of it, and gives a place only to someone who is signed in", async () => {
    const { put, waiting, looked } = await routes({ piecesAtOnce: 1 });
    expect((await put({ origin: "https://elsewhere.example" })).statusCode).toBe(403);
    expect((await put({ [REQUEST_HEADER]: "" })).statusCode).toBe(403);
    const nobody = await put({ cookie: "" });
    expect(nobody.statusCode).toBe(401);
    expect(nobody.json()).toEqual({ error: "signedOut" });
    expect(looked).not.toHaveBeenCalled();
    // A cookie that looks like one, of a session nobody has: asked about, and turned away.
    const madeUp = await put({ cookie: `${SESSION_COOKIE}=${randomToken()}` });
    expect(madeUp.statusCode).toBe(401);
    expect(madeUp.json()).toEqual({ error: "signedOut" });
    expect(looked).toHaveBeenCalledTimes(1);
    // None of them held a place.
    const fine = put();
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting.shift()!.go();
    expect((await fine).statusCode).toBe(200);
  });

  test("a piece that is not one: without where it goes, of another kind, or larger than any may be, which is not read", async () => {
    const { put, open, waiting } = await routes({ piecesAtOnce: 1 });
    expect((await put({ "upload-offset": "x" })).statusCode).toBe(400);
    const text = await put({ "content-type": "text/plain" });
    expect(text.statusCode).toBe(400);
    expect(text.json()).toEqual({ error: "invalid" });
    const picture = await put({ "content-type": "image/png" });
    expect(picture.statusCode).toBe(415);
    expect(picture.json()).toEqual({ error: "invalid" });
    const large = await put({}, Buffer.alloc(CHUNK + 1));
    expect(large.statusCode).toBe(413);
    expect(large.json()).toEqual({ error: "tooLarge" });
    // One that does not say how large it is, is read up to what a piece may have, and no further.
    const endless = await open(undefined);
    const part = Buffer.alloc(600, 7);
    endless.socket.write(`${part.length.toString(16)}\r\n`);
    endless.socket.write(part);
    endless.socket.write(`\r\n${part.length.toString(16)}\r\n`);
    endless.socket.write(part);
    endless.socket.write("\r\n");
    await vi.waitFor(() => expect(endless.status()).toBe(413));
    expect(endless.answer()).toContain('{"error":"tooLarge"}');
    expect(endless.answer().toLowerCase()).toContain("connection: close");
    expect(waiting).toHaveLength(0);
    // As large as a piece may be goes, and none of these held a place.
    const whole = put({}, Buffer.alloc(CHUNK, 3));
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(waiting[0]!.piece).toEqual(Buffer.alloc(CHUNK, 3));
    waiting.shift()!.go();
    expect((await whole).statusCode).toBe(200);
  });

  test("a sender that goes away once all of its piece is in, before the answer, lets go of its place", async () => {
    // The hooks of Fastify hear nothing of that end: the request was whole, and no answer goes out.
    const { put, open, waiting, seen, noConnections } = await routes({
      piecesAtOnce: 2,
      piecesPerPerson: 2,
    });
    for (let round = 0; round < 3; round++) {
      const leaving = [await open(10), await open(10)];
      for (const each of leaving) each.socket.write("0123456789");
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      for (const each of leaving) each.socket.destroy();
      await noConnections();
      // Still in memory, still in its place, until it is written.
      const early = await put();
      expect(early.statusCode, `round ${round}`).toBe(429);
      for (const each of waiting.splice(0)) each.go();
      await vi.waitFor(() => expect(seen.taken).toBe(0));
    }
    const fine = put();
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting.shift()!.go();
    expect((await fine).statusCode).toBe(200);
  });

  test("requests that nobody is signed in for, gone before their answer, take no place from anybody", async () => {
    const { put, open, waiting, looked, seen, noConnections } = await routes({
      piecesAtOnce: 3,
      piecesPerPerson: 3,
    });
    for (let count = 0; count < 12; count++) {
      const anonymous = await open(1, { cookie: `${SESSION_COOKIE}=${randomToken()}` });
      anonymous.socket.write("x");
      // All of the request is in, and it goes before it is known who it is.
      await vi.waitFor(() => expect(looked).toHaveBeenCalledTimes(count + 1));
      anonymous.socket.destroy();
    }
    await vi.waitFor(() => expect(seen.asked).toBe(12));
    await noConnections();
    expect(seen.mostTaken).toBe(0);
    const pieces = [put(), put(), put()];
    await vi.waitFor(() => expect(waiting).toHaveLength(3));
    for (const each of waiting.splice(0)) each.go();
    for (const each of pieces) expect((await each).statusCode).toBe(200);
  });

  test("someone signed in who goes away while it is asked who it is takes no place either", async () => {
    const { put, open, waiting, looked, seen, noConnections } = await routes({ piecesAtOnce: 1 });
    for (let count = 0; count < 5; count++) {
      const leaving = await open(10);
      leaving.socket.write("0123456789");
      await vi.waitFor(() => expect(looked).toHaveBeenCalledTimes(count + 1));
      leaving.socket.destroy();
    }
    await vi.waitFor(() => expect(seen.asked).toBe(5));
    await noConnections();
    for (const each of waiting.splice(0)) each.go();
    await vi.waitFor(() => expect(seen.taken).toBe(0));
    const fine = put();
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting.shift()!.go();
    expect((await fine).statusCode).toBe(200);
  });

  test("a piece has to keep coming: one that comes too slowly is turned away and lets go of its place, one that is slow but fast enough gets through", async () => {
    // The time the routes go by, which the test moves on: 1000 bytes a second after 10 seconds.
    let clock = 1_000_000;
    const {
      put,
      open,
      waiting,
      paced: looked,
    } = await routes({
      piecesAtOnce: 1,
      now: () => clock,
      pace: { bytesPerSecond: 1000, graceMs: 10_000, checkMs: 10 },
    });

    // Its head, and then nothing: a line that went dead. Nothing happens while it may get going.
    const dead = await open(CHUNK);
    await looked();
    clock += 9_000;
    await looked();
    expect(dead.status()).toBeUndefined();
    await vi.waitFor(() => {
      // Past the moment it had to get going, however late the routes began with it.
      clock += 20_000;
      expect(dead.status()).toBe(408);
    });
    expect(dead.answer()).toContain('{"error":"slow"}');
    expect(dead.answer().toLowerCase()).toContain("connection: close");
    expect(waiting).toHaveLength(0);
    // Its connection goes with the answer: what is left of the piece is not waited for.
    await vi.waitFor(() => expect(dead.socket.destroyed || dead.socket.readableEnded).toBe(true));

    // A few bytes, far below what it has to be by then: its place was free, and is again.
    const trickle = await open(CHUNK);
    trickle.socket.write(Buffer.alloc(20));
    await looked();
    await vi.waitFor(() => {
      clock += 20_000;
      expect(trickle.status()).toBe(408);
    });

    // Slow, but as fast as it has to be: half of it after 10.4 seconds, where 400 bytes are due.
    const steady = await open(CHUNK);
    steady.socket.write(Buffer.alloc(CHUNK / 2, 5));
    await looked();
    clock += 10_400;
    await looked();
    expect(steady.status()).toBeUndefined();
    steady.socket.write(Buffer.alloc(CHUNK / 2, 5));
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(waiting[0]!.piece).toEqual(Buffer.alloc(CHUNK, 5));
    // All of it is in: however long it takes to write, it is not too slow any more. Nothing looks
    // at how fast it came any more, so there is nothing to wait for but a moment.
    clock += 600_000;
    await sleep(30);
    waiting.shift()!.go();
    await vi.waitFor(() => expect(steady.status()).toBe(200));
    steady.socket.destroy();

    // A small piece that is all there within the moment it has to get going is never too slow.
    const small = put({}, Buffer.alloc(3));
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting.shift()!.go();
    expect((await small).statusCode).toBe(200);
  });

  test("a sender that goes away in the middle of its piece lets go of its place", async () => {
    const { put, open, waiting, seen } = await routes({ piecesAtOnce: 1 });
    const half = await open(CHUNK);
    half.socket.write(Buffer.alloc(100));
    await vi.waitFor(() => expect(seen.taken).toBe(1));
    half.socket.destroy();
    await vi.waitFor(() => expect(seen.taken).toBe(0));
    expect(waiting).toHaveLength(0);
    const fine = put();
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting.shift()!.go();
    expect((await fine).statusCode).toBe(200);
  });
});
