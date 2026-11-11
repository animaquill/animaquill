import { describe, expect, it } from "vitest";
import {
  SYNC_CLOSE,
  SYNC_PROTOCOL,
  encodeSyncMessage,
  readSyncClientMessage,
  readSyncServerMessage,
  type SyncClientMessage,
  type SyncServerMessage,
} from "./sync-protocol.ts";

/** Which working copy of a project a window has, and the platform, see `generation`. */

const hello: SyncClientMessage = {
  t: "hello",
  v: SYNC_PROTOCOL,
  project: "p1",
  after: 4,
  digest: "d4",
  device: "device1",
  window: "window1",
  editor: "0.5.1",
  payload: new Uint8Array(0),
};
const welcome: SyncServerMessage = { t: "welcome", head: 9, digest: "d9", reset: false };

const frame = (header: object): Uint8Array => {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + head.length);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  return out;
};

describe("the copies of a project in the sync protocol", () => {
  it("says which copy a window has, and which one the platform has", () => {
    const said = readSyncClientMessage(encodeSyncMessage({ ...hello, generation: 2 }));
    expect(said).toEqual({ ...hello, generation: 2 });
    const answered = readSyncServerMessage(encodeSyncMessage({ ...welcome, generation: 2 }));
    expect(answered).toEqual({ ...welcome, generation: 2 });
  });

  it("goes without it, as a window and a platform from before do", () => {
    expect(readSyncClientMessage(encodeSyncMessage(hello))).toEqual(hello);
    expect(readSyncServerMessage(encodeSyncMessage(welcome))).toEqual(welcome);
    expect(readSyncClientMessage(encodeSyncMessage(hello))).not.toHaveProperty("generation");
    expect(readSyncServerMessage(encodeSyncMessage(welcome))).not.toHaveProperty("generation");
  });

  it("is no message where the copy is not a number", () => {
    const { payload: _payload, ...header } = hello;
    expect(readSyncClientMessage(frame({ ...header, generation: "2" }))).toBeUndefined();
    expect(readSyncClientMessage(frame({ ...header, generation: -1 }))).toBeUndefined();
    expect(readSyncClientMessage(frame({ ...header, generation: 1.5 }))).toBeUndefined();
    expect(readSyncServerMessage(frame({ ...welcome, generation: "2" }))).toBeUndefined();
    // What neither side knows yet does no harm: it is left out.
    expect(readSyncClientMessage(frame({ ...header, somethingNew: true }))).toEqual(hello);
    expect(readSyncServerMessage(frame({ ...welcome, somethingNew: true }))).toEqual(welcome);
  });

  it("has a way of its own to say that the platform has another copy", () => {
    const codes = Object.values(SYNC_CLOSE);
    expect(SYNC_CLOSE.rebuilt).toBe(4409);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
