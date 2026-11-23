import { chmodSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { IdentityRefused, KEY_FILE, loadIdentity, type RelayIdentity } from "./identity.ts";
import { ElectedLink } from "./link.ts";
import { allowOrigin, allowedOrigins } from "./origins.ts";
import { admit } from "./relay.ts";
import { FakePage, cleanUp, sampleFolder, storeOf, tempFolder } from "./test-support.ts";
import { ownerOf } from "./uid.ts";

/**
 * The relay of AI tools on this computer (docs/design/online-offline.md of AnimaQuill Cloud, 5.1,
 * 5.2): who it lets in, how the processes of one user agree on one, and that a call goes once.
 */

const links: ElectedLink[] = [];
afterEach(async () => {
  await Promise.all(links.splice(0).map((link) => link.close()));
  cleanUp();
});

let nextPorts = 48_100 + (process.pid % 40) * 10;
const portsOfTest = () => {
  nextPorts += 10;
  return { first: nextPorts, count: 3 };
};

const ORIGIN = "https://editor.test";

async function linkOf(identity: RelayIdentity, ports: { first: number; count: number }) {
  const link = new ElectedLink({
    identity,
    allowed: await allowedOrigins(tempFolder(), [ORIGIN]),
    toolset: "t",
    list: "l",
    ports,
  });
  links.push(link);
  await link.start();
  return link;
}

const request = (headers: Record<string, string>, url = "/page?nonce=x", remotePort = 1) =>
  ({ headers, url, socket: { remotePort } }) as unknown as IncomingMessage;

describe("who the relay lets in", () => {
  it("takes pages of allowed origins at 127.0.0.1 or localhost by its port, and nothing else", async () => {
    const allowed = await allowedOrigins(tempFolder(), [ORIGIN]);
    const own = async () => true;
    const page = { host: "127.0.0.1:47300", origin: ORIGIN };
    expect(await admit(request(page), 47_300, allowed, own)).toEqual({
      kind: "page",
      origin: ORIGIN,
    });
    expect(
      await admit(request({ ...page, host: "localhost:47300" }), 47_300, allowed, own),
    ).toMatchObject({ kind: "page" });
    // DNS rebinding: another name that leads here.
    expect(await admit(request({ ...page, host: "evil.test:47300" }), 47_300, allowed, own)).toBe(
      "host",
    );
    expect(await admit(request({ ...page, host: "127.0.0.1:47301" }), 47_300, allowed, own)).toBe(
      "host",
    );
    expect(
      await admit(request({ ...page, origin: "https://evil.test" }), 47_300, allowed, own),
    ).toBe("origin");
    expect(await admit(request({ host: page.host }), 47_300, allowed, own)).toBe("origin");
    expect(await admit(request(page, "/other"), 47_300, allowed, own)).toBe("path");
    // Another user of this computer.
    expect(await admit(request(page), 47_300, allowed, async () => false)).toBe("user");
    // A peer comes without Origin: every page has one.
    expect(await admit(request({ host: page.host }, "/peer"), 47_300, allowed, own)).toEqual({
      kind: "peer",
    });
    expect(await admit(request(page, "/peer"), 47_300, allowed, own)).toBe("origin");
  });

  it("takes the editor of npx animaquill, but not the sites of its scenes", async () => {
    const allowed = await allowedOrigins(tempFolder());
    expect(allowed.has("http://animaquill.localhost:7651")).toBe(true);
    expect(allowed.has("http://animaquill.localhost:9000")).toBe(true);
    expect(allowed.has("http://animaquill-scene-0.localhost:7651")).toBe(false);
    expect(allowed.has("http://animaquill-sandbox.localhost:7651")).toBe(false);
    expect(allowed.has("http://localhost:7651")).toBe(false);
    expect(allowed.has("null")).toBe(false);
    expect(allowed.has(undefined)).toBe(false);
  });

  it("keeps an origin that people allow, for every process after", async () => {
    const home = tempFolder();
    expect(await allowOrigin(home, "https://aq.example.test/start?x=1")).toBe(
      "https://aq.example.test",
    );
    await expect(allowOrigin(home, "file:///x")).rejects.toThrow(/no address/);
    expect((await allowedOrigins(home)).has("https://aq.example.test")).toBe(true);
  });

  it("tells the user of a connection from /proc/net/tcp", async () => {
    const folder = tempFolder();
    const file = join(folder, "tcp");
    writeFileSync(
      file,
      [
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
        "   0: 0100007F:B8D4 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 1",
        "   1: 0100007F:9C40 0100007F:B8D4 01 00000000:00000000 00:00000000 00000000  1000        0 2",
      ].join("\n"),
    );
    // The other end is the socket at its port, connected to ours.
    expect(await ownerOf(0x9c40, 0xb8d4, [file])).toBe(1001);
    expect(await ownerOf(0x9c40, 0x1234, [file])).toBeUndefined();
  });
});

describe("the identity", () => {
  it("is made once, for this user only, and a key others can read is refused", async () => {
    const home = tempFolder();
    const [a, b] = await Promise.all([loadIdentity(home), loadIdentity(home)]);
    expect(a.publicKey).toBe(b.publicKey);
    expect(b.checks("x", a.mac("x"))).toBe(true);
    if (process.platform !== "win32") {
      chmodSync(join(home, KEY_FILE), 0o644);
      await expect(loadIdentity(home)).rejects.toBeInstanceOf(IdentityRefused);
    }
  });
});

describe("the processes of one user", { timeout: 30_000 }, () => {
  it("agree on one relay; another user's process is no peer, and gets a port of its own", async () => {
    const ports = portsOfTest();
    const identity = await loadIdentity(tempFolder());
    const first = await linkOf(identity, ports);
    const second = await linkOf(identity, ports);
    expect(first.role).toEqual({ kind: "relay", port: ports.first });
    expect(second.role).toEqual({ kind: "peer", port: ports.first });
    // Another key: the relay does not take it, and it does not take the relay.
    const stranger = await linkOf(await loadIdentity(tempFolder()), ports);
    expect(stranger.role).toEqual({ kind: "relay", port: ports.first + 1 });
  });

  it("refuses a peer that cannot prove the key, before it hears anything of it", async () => {
    const ports = portsOfTest();
    await linkOf(await loadIdentity(tempFolder()), ports);
    const ws = new WebSocket(`ws://127.0.0.1:${ports.first}/peer`);
    const said: string[] = [];
    ws.on("message", (data) => {
      said.push(String(data));
      ws.send(JSON.stringify({ t: "peer-auth", nonce: "n".repeat(20), mac: "forged" }));
    });
    const code = await new Promise<number>((resolve) => ws.on("close", resolve));
    expect(code).toBe(1008);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/peer-hello/);
  });

  it("send a call again once the relay changed, which the page answers once", async () => {
    const ports = portsOfTest();
    const identity = await loadIdentity(tempFolder());
    const relay = await linkOf(identity, ports);
    const peer = await linkOf(identity, ports);
    const root = sampleFolder();
    const store = await storeOf(root);
    const page = new FakePage({
      port: ports.first,
      origin: ORIGIN,
      store,
      project: { mode: "online", key: "p1", id: "x", name: "宣传片" },
      page: "page-1",
    });
    await page.connect();
    peer.session({ session: "s", target: { kind: "front" }, since: 0 });
    const operations = [
      {
        op: "clip.add",
        timeline: "main",
        track: "track_video",
        id: "clip_once",
        start: "31",
        duration: "4",
        source: { kind: "scene", scene: "title" },
      },
    ];
    const read = { call: "s-0", session: "s", answer: "0", tool: "aq_timeline_read" };
    await peer.call({ ...read, args: { timeline: "main" } });
    const call = { call: "s-1", session: "s", answer: "1", tool: "aq_edit", args: { operations } };
    const done = await peer.call(call);
    expect(done.kind === "result" && done.result.isError).toBe(false);
    expect(done.kind === "result" && done.bound.project.name).toBe("宣传片");
    // The same call again, as after the relay changed: answered as before, not done twice.
    await relay.close();
    // The same page connects again, to whichever of them is the relay now.
    let back = false;
    for (let tries = 0; tries < 50 && !back; tries += 1) {
      back = await page.connect().then(
        () => true,
        () => new Promise<boolean>((wait) => setTimeout(() => wait(false), 100)),
      );
    }
    expect(peer.role?.kind).toBe("relay");
    const twice = await peer.call(call);
    expect(twice.kind === "result" && twice.result).toEqual(done.kind === "result" && done.result);
    page.close();
    store.destroy();
  });
});
