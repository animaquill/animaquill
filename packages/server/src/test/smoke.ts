import { randomBytes } from "node:crypto";
import { ProjectStore } from "@animaquill/core";
import {
  Reassembler,
  SYNC_LIMITS,
  SYNC_PROTOCOL,
  framesOf,
  readSyncServerMessage,
  type SyncClientMessage,
  type SyncServerMessage,
} from "@animaquill/host/sync";
import { createProject } from "@animaquill/schema";
import { Client } from "pg";
import { WebSocket } from "ws";
import { SESSION_COOKIE } from "../auth/cookies.ts";
import { hashOf } from "../seal.ts";

/**
 * A run of the server on its own, as a browser would use it: someone signed in (a session put into
 * the database, as nothing of GitHub is set up to sign in with), a project made, opened, changed,
 * and opened again as after a refresh, with the change there; then the list and the repository of
 * the project. For scripts/oss-server-run of the platform's repository, against the API of main.ts:
 *   SMOKE_API=http://127.0.0.1:8300 SMOKE_DATABASE=postgres://… node src/test/smoke.ts
 * PUBLIC_ORIGIN of the API is what the browser's Origin is said to be. Ends with 0 where all went.
 */

const api = process.env["SMOKE_API"] ?? "http://127.0.0.1:8300";
const origin = process.env["SMOKE_ORIGIN"] ?? "http://localhost:8300";
const database = process.env["SMOKE_DATABASE"];
if (!database) throw new Error("SMOKE_DATABASE is not set");

const step = (what: string) => process.stdout.write(`smoke: ${what}\n`);

/** Someone, signed in: a person and a session of theirs. */
const signIn = async (): Promise<string> => {
  const client = new Client({ connectionString: database });
  await client.connect();
  try {
    const token = randomBytes(24).toString("base64url");
    const githubId = 900_000_000 + Math.floor(Math.random() * 1_000_000);
    const { rows } = await client.query<{ id: string }>(
      "insert into users (github_id, login) values ($1, $2) returning id",
      [githubId, `smoke-${githubId}`],
    );
    await client.query(
      "insert into sessions (id_hash, user_id, expires_at) values ($1, $2, now() + interval '1 hour')",
      [hashOf(token), rows[0]!.id],
    );
    return token;
  } finally {
    await client.end();
  }
};

/** A WebSocket of syncing, as the editor opens one, and what it is sent. */
const connect = async (session: string) => {
  const socket = new WebSocket(`${api.replace(/^http/, "ws")}/api/sync`, {
    headers: { origin, cookie: `${SESSION_COOKIE}=${session}` },
  });
  const messages: SyncServerMessage[] = [];
  let closed: string | undefined;
  socket.on("close", (code, reason) => {
    closed = `${code} ${reason.toString()}`;
  });
  const frames = new Reassembler(SYNC_LIMITS.state);
  socket.on("message", (data) => {
    const whole = frames.take(new Uint8Array(data as Buffer));
    if (whole === "more") return;
    const message = whole && readSyncServerMessage(whole);
    if (message) messages.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const send = (message: SyncClientMessage) => {
    for (const frame of framesOf(message)) socket.send(frame);
  };
  const until = async <T extends SyncServerMessage["t"]>(t: T) => {
    for (let turn = 0; turn < 1000; turn++) {
      const found = messages.find((message) => message.t === t);
      if (found) return found as Extract<SyncServerMessage, { t: T }>;
      if (socket.readyState === WebSocket.CLOSED) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `no "${t}" came: ${JSON.stringify(messages.map((message) => message.t))}, closed ${closed}`,
    );
  };
  return { socket, messages, send, until };
};

const session = await signIn();
step("signed in");

const id = `smoke-${randomBytes(6).toString("hex")}`;
const store = ProjectStore.create(createProject({ name: "冒烟" }));
const updates: Uint8Array[] = [];
store.onLocalUpdate((update) => updates.push(update));
const made = await connect(session);
made.send({
  t: "hello",
  v: SYNC_PROTOCOL,
  project: id,
  after: 0,
  device: "smoke",
  window: "w1",
  editor: "dev",
  create: { name: "冒烟", projectId: store.getState().manifest.id },
  payload: store.encodeState(),
});
const synced = await made.until("synced");
step(`made ${id} (head ${synced.head})`);

store.execute({
  type: "file.write",
  params: { path: "code/smoke.js", text: "export const a = 1;\n" },
});
made.send({
  t: "push",
  id: 1,
  kind: "user",
  base: synced.head,
  at: Date.now(),
  window: "w1",
  behind: false,
  payload: updates[0]!,
});
const ack = await made.until("ack");
step(`changed (seq ${ack.seq})`);
made.socket.close();

// As after a refresh with nothing kept in the browser: all of it from the server.
const again = await connect(session);
again.send({
  t: "hello",
  v: SYNC_PROTOCOL,
  project: id,
  after: 0,
  device: "smoke",
  window: "w2",
  editor: "dev",
  payload: new Uint8Array(0),
});
await again.until("synced");
const read = ProjectStore.fromUpdates(
  again.messages.flatMap((message) => (message.t === "update" ? [message.payload] : [])),
);
again.socket.close();
const text = read.store?.exportFiles().files.get("code/smoke.js");
if (text !== "export const a = 1;\n")
  throw new Error(`opened again, the change is not there: ${text}`);
step("opened again, with the change");

const headers = { cookie: `${SESSION_COOKIE}=${session}`, origin };
const listed = (await (await fetch(`${api}/api/projects`, { headers })).json()) as {
  projects: { id: string; name: string }[];
};
if (!listed.projects.some((project) => project.id === id && project.name === "冒烟"))
  throw new Error(`not in the list: ${JSON.stringify(listed)}`);
step("listed");

const repository = await fetch(`${api}/api/projects/${id}/repository`, { headers });
step(`repository: ${repository.status} ${await repository.text()}`);
step("done");
process.exit(0);
