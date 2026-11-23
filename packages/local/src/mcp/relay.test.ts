import { chmodSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { IdentityRefused, KEY_FILE, loadIdentity, type RelayIdentity } from "./identity.ts";
import { ElectedLink } from "./link.ts";
import { allowOrigin, allowedOrigins } from "./origins.ts";
import { openCommand } from "../open-browser.ts";
import { peerProof } from "./peer.ts";
import { rememberOrigin } from "./state.ts";
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
    // The same ports at another loopback address are somebody else's connection.
    writeFileSync(
      file,
      [
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
        "   0: 0200007F:B8D4 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 1",
      ].join("\n"),
    );
    expect(await ownerOf(0x9c40, 0xb8d4, [file])).toBeUndefined();
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

describe("what review O5a found", { timeout: 30_000 }, () => {
  it("binds a session on the project in front at its first call, not at its start", async () => {
    const ports = portsOfTest();
    const link = await linkOf(await loadIdentity(tempFolder()), ports);
    const storeA = await storeOf(sampleFolder());
    const storeB = await storeOf(sampleFolder());
    const a = new FakePage({
      port: ports.first,
      origin: ORIGIN,
      store: storeA,
      frontAt: 1_000,
      project: { mode: "online", key: "A", id: "a", name: "项目A" },
      page: "pa",
    });
    await a.connect();
    link.session({ session: "s", target: { kind: "front" }, since: 0 });
    await new Promise((done) => setTimeout(done, 300));
    // The user now works in B, which is in front.
    const b = new FakePage({
      port: ports.first,
      origin: ORIGIN,
      store: storeB,
      frontAt: 2_000,
      project: { mode: "online", key: "B", id: "b", name: "项目B" },
      page: "pb",
    });
    await b.connect();
    // What B says it has open reaches the relay.
    await new Promise((done) => setTimeout(done, 300));
    const answer = await link.call({
      call: "s-1",
      session: "s",
      answer: "1",
      tool: "aq_project_status",
      args: {},
    });
    expect(answer.kind === "result" && answer.bound.project.name).toBe("项目B");
    a.close();
    b.close();
    storeA.destroy();
    storeB.destroy();
  });

  it("lets a peer go that says what it cannot, and stays up for the others", async () => {
    const ports = portsOfTest();
    const identity = await loadIdentity(tempFolder());
    const relay = await linkOf(identity, ports);
    // A peer of the same user, proving the key, then sending what no version sends.
    const ws = new WebSocket(`ws://127.0.0.1:${ports.first}/peer`);
    const nonce = "n".repeat(20);
    const closed = new Promise<number>((resolve) => ws.on("close", resolve));
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { t: string; nonce?: string };
      if (message.t === "peer-hello") {
        ws.send(
          JSON.stringify({
            t: "peer-auth",
            nonce,
            protocol: 1,
            mac: identity.mac(peerProof(message.nonce ?? "", ports.first)),
          }),
        );
      } else if (message.t === "peer-ok") {
        ws.send(JSON.stringify({ t: "session", info: { session: 5 } }));
      }
    });
    expect(await closed).toBe(1008);
    // Another peer still gets in.
    const other = await linkOf(identity, ports);
    expect(relay.role?.kind).toBe("relay");
    expect(other.role).toEqual({ kind: "peer", port: ports.first });
  });

  it("takes no proof of the key that was made for another port", async () => {
    const ports = portsOfTest();
    const identity = await loadIdentity(tempFolder());
    await linkOf(identity, ports);
    const ws = new WebSocket(`ws://127.0.0.1:${ports.first}/peer`);
    const closed = new Promise<number>((resolve) => ws.on("close", resolve));
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as { t: string; nonce?: string };
      if (message.t !== "peer-hello") return;
      ws.send(
        JSON.stringify({
          t: "peer-auth",
          nonce: "n".repeat(20),
          protocol: 1,
          mac: identity.mac(peerProof(message.nonce ?? "", ports.first + 1)),
        }),
      );
    });
    expect(await closed).toBe(1008);
  });
});

describe("a site added while the relay runs", { timeout: 30_000 }, () => {
  it("connects without restarting it, and the relay says at /ping whether it takes a site", async () => {
    const ports = portsOfTest();
    const home = tempFolder();
    const link = new ElectedLink({
      identity: await loadIdentity(home),
      allowed: await allowedOrigins(home),
      toolset: "t",
      list: "l",
      ports,
    });
    links.push(link);
    await link.start();
    const ping = async (origin?: string) => {
      const response = await fetch(`http://127.0.0.1:${ports.first}/ping`, {
        ...(origin && { headers: { origin } }),
      });
      return {
        status: response.status,
        body: response.status === 200 ? await response.json() : undefined,
      };
    };
    expect(await ping(ORIGIN)).toEqual({ status: 200, body: { relay: true, allowed: false } });
    // Nothing for a request that is no page's.
    expect((await ping()).status).toBe(404);
    const store = await storeOf(sampleFolder());
    const page = new FakePage({
      port: ports.first,
      origin: ORIGIN,
      store,
      project: { mode: "online", key: "p", id: "x", name: "x" },
    });
    await expect(page.connect()).rejects.toThrow();
    await allowOrigin(home, ORIGIN);
    expect(await ping(ORIGIN)).toEqual({ status: 200, body: { relay: true, allowed: true } });
    await page.connect();
    page.close();
    store.destroy();
  });
});

describe("a call that waited at a relay that went", { timeout: 30_000 }, () => {
  it("goes to the next relay as it is, and runs: it ran nowhere", async () => {
    const ports = portsOfTest();
    const identity = await loadIdentity(tempFolder());
    const relay = await linkOf(identity, ports);
    const peer = await linkOf(identity, ports);
    peer.session({ session: "s", target: { kind: "front" }, since: 0 });
    // No page yet: the call waits at the relay, which goes.
    const call = peer.call({
      call: "s-1",
      session: "s",
      answer: "1",
      tool: "aq_file_write",
      args: { path: "code/waited.js", text: "export const a = 1;\n" },
    });
    await new Promise((done) => setTimeout(done, 300));
    await relay.close();
    const store = await storeOf(sampleFolder());
    const page = new FakePage({
      port: ports.first,
      origin: ORIGIN,
      store,
      project: { mode: "online", key: "p1", id: "x", name: "宣传片" },
    });
    for (let tries = 0; tries < 50 && !page.key; tries += 1) {
      await page.connect().catch(() => new Promise((wait) => setTimeout(wait, 100)));
    }
    const answer = await call;
    expect(answer.kind === "result" && answer.result.text).not.toMatch(/outcome-unknown/);
    expect(answer.kind === "result" && answer.result.isError).toBe(false);
    expect(store.getState().files["code/waited.js"]).toContain("a = 1");
    page.close();
    store.destroy();
  });
});

describe("a call that finds no editor (O5b)", { timeout: 30_000 }, () => {
  async function opener(home: string, ports: { first: number; count: number }) {
    const opened: string[] = [];
    const link = new ElectedLink({
      identity: await loadIdentity(home),
      allowed: await allowedOrigins(home, [ORIGIN]),
      toolset: "t",
      list: "l",
      ports,
      home,
      open: (url) => opened.push(url),
      openWaitMs: 300,
      giveUpMs: 1_500,
    });
    links.push(link);
    await link.start();
    return { link, opened };
  }
  const folderTarget = {
    kind: "folder" as const,
    id: "proj_1",
    name: "宣传片",
    root: "/x",
    probe: { path: ".animaquill/mcp/probe-s.json", nonce: "n" },
  };
  const call = (n: number) => ({
    call: `s-${n}`,
    session: "s",
    answer: String(n),
    tool: "aq_project_status",
    args: {},
  });

  it("opens the editor of the last site once, on the folder's project, and gives up in the end", async () => {
    const home = tempFolder();
    await rememberOrigin(home, ORIGIN);
    const { link, opened } = await opener(home, portsOfTest());
    link.session({ session: "s", target: folderTarget, since: 0 });
    const said: string[] = [];
    const first = await link.call(call(1), undefined, { progress: (text) => said.push(text) });
    expect(first).toEqual({ kind: "opening", name: "宣传片", how: "opened" });
    expect(opened).toEqual([`${ORIGIN}/offline?open=proj_1`]);
    expect(said[0]).toMatch(/opening the AnimaQuill editor on "宣传片"/);
    // Once a session.
    expect((await link.call(call(2))).kind).toBe("opening");
    expect(opened).toHaveLength(1);
    await new Promise((done) => setTimeout(done, 1_600));
    expect(await link.call(call(3))).toEqual({ kind: "no-page", gaveUp: true });
  });

  it("opens no site that is not allowed now, nor where none connected ever", async () => {
    const home = tempFolder();
    await rememberOrigin(home, "https://elsewhere.test");
    const { link, opened } = await opener(home, portsOfTest());
    link.session({ session: "s", target: folderTarget, since: 0 });
    // Nothing can bring an editor: it says so, without waiting.
    expect((await link.call(call(1))).kind).toBe("no-page");
    const none = await opener(tempFolder(), portsOfTest());
    none.link.session({ session: "s", target: folderTarget, since: 0 });
    await none.link.call(call(1));
    expect([...opened, ...none.opened]).toEqual([]);
  });

  it("tells the pages that are open, and opens nothing, where there are some", async () => {
    const home = tempFolder();
    await rememberOrigin(home, ORIGIN);
    const ports = portsOfTest();
    const { link, opened } = await opener(home, ports);
    const store = await storeOf(sampleFolder());
    const page = new FakePage({
      port: ports.first,
      origin: ORIGIN,
      store,
      project: { mode: "online", key: "other", id: "o", name: "别的" },
    });
    await page.connect();
    link.session({ session: "s", client: { name: "claude-code" }, target: folderTarget, since: 0 });
    expect((await link.call(call(1))).kind).toBe("opening");
    expect(opened).toEqual([]);
    const waiting = page.received.map((raw) => JSON.parse(raw)).filter(({ t }) => t === "waiting");
    expect(waiting.at(-1)?.waiting).toMatchObject([
      { mode: "offline", id: "proj_1", name: "宣传片", clients: [{ name: "claude-code" }] },
    ]);
    page.close();
    store.destroy();
  });

  it("says a page has the project and is not let at its folder", async () => {
    const home = tempFolder();
    const ports = portsOfTest();
    const { link } = await opener(home, ports);
    const store = await storeOf(sampleFolder());
    const page = new FakePage({
      port: ports.first,
      origin: ORIGIN,
      store,
      project: { mode: "offline", key: "f1", id: "proj_1", name: "宣传片" },
      serving: false,
      blocked: "needs-permission",
    });
    await page.connect();
    link.session({ session: "s", target: folderTarget, since: 0 });
    expect(await link.call(call(1))).toEqual({ kind: "needs-permission", name: "宣传片" });
    page.close();
    store.destroy();
  });
});

describe("opening the browser", () => {
  it("gives the address as one argument, through no shell, on every system", () => {
    const url = "https://editor.test/offline?open=a&b=c";
    expect(openCommand(url, "win32", undefined)).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
    expect(openCommand(url, "darwin", undefined)).toEqual({ command: "open", args: [url] });
    expect(openCommand(url, "linux", undefined)).toEqual({ command: "xdg-open", args: [url] });
    expect(openCommand(url, "linux", "/opt/fake")).toEqual({ command: "/opt/fake", args: [url] });
  });
});
