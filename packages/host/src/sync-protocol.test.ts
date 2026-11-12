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

  it("has a way of its own to say that the project was deleted", () => {
    expect(SYNC_CLOSE.deleted).toBe(4410);
    expect(Object.values(SYNC_CLOSE).filter((code) => code === 4410)).toHaveLength(1);
  });

  it("has a way of its own to say that the project cannot be edited", () => {
    expect(SYNC_CLOSE.unusable).toBe(4412);
    expect(Object.values(SYNC_CLOSE).filter((code) => code === 4412)).toHaveLength(1);
  });

  it("says that a window only reads the project, which a window from before does not", () => {
    expect(readSyncClientMessage(encodeSyncMessage({ ...hello, readOnly: true }))).toEqual({
      ...hello,
      readOnly: true,
    });
    // Saying it does not is saying nothing.
    const notSaid = readSyncClientMessage(encodeSyncMessage({ ...hello, readOnly: false }));
    expect(notSaid).toEqual(hello);
    expect(notSaid).not.toHaveProperty("readOnly");
    const { payload: _payload, ...header } = hello;
    for (const wrong of ["true", 1, null])
      expect(readSyncClientMessage(frame({ ...header, readOnly: wrong }))).toBeUndefined();
  });

  it("says that a window asks for the copy as it began, which a window from before does not", () => {
    const asked = { ...hello, readOnly: true, base: true } as const;
    expect(readSyncClientMessage(encodeSyncMessage(asked))).toEqual(asked);
    const notSaid = readSyncClientMessage(encodeSyncMessage({ ...hello, base: false }));
    expect(notSaid).toEqual(hello);
    expect(notSaid).not.toHaveProperty("base");
    const { payload: _payload, ...header } = hello;
    for (const wrong of ["true", 1, null])
      expect(readSyncClientMessage(frame({ ...header, base: wrong }))).toBeUndefined();
  });
});
