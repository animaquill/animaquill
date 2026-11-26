import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BACKEND_META, startLocalServer, type LocalApi, type LocalServer } from "../server.ts";

/**
 * The server of this package with the backend behind it (design O4 of AnimaQuill Cloud, section
 * 1): `/api` and its WebSocket only on the editor's own name, and the page says the backend is
 * there; the scene and compositor sites, and this computer by other names, get none of it.
 */

const TEMPLATE = '<!doctype html><html data-editors="[]"><title>Scene</title></html>';

describe("the server with the backend", () => {
  let folder: string;
  let server: LocalServer;
  let port: number;
  let api: LocalApi | undefined;
  const reached: string[] = [];
  const upgraded: string[] = [];

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "animaquill-backend-"));
    const site = join(folder, "site");
    mkdirSync(site, { recursive: true });
    writeFileSync(
      join(site, "index.html"),
      "<!doctype html><html><head><title>AnimaQuill</title></head></html>",
    );
    writeFileSync(join(site, "compositor.html"), "<!doctype html><title>合成器</title>");
    for (let attempt = 0; ; attempt++) {
      port = 20_000 + Math.floor(Math.random() * 20_000);
      try {
        server = await startLocalServer({ site, scenePage: TEMPLATE, port, backend: () => api });
        break;
      } catch (error) {
        if (attempt > 5) throw error;
      }
    }
  });
  afterAll(async () => {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  });

  const send = (host: string, path: string, method = "GET") =>
    new Promise<{ status: number; body: string }>((done, fail) => {
      const sent = request(
        { host: "127.0.0.1", port, path, method, headers: { host } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (part: string) => (body += part));
          response.on("end", () => done({ status: response.statusCode ?? 0, body }));
        },
      );
      sent.on("error", fail);
      sent.end();
    });
  const upgrade = (host: string, path: string) =>
    new Promise<string>((done) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      let text = "";
      socket.on("data", (part) => (text += part.toString()));
      socket.on("close", () => done(text.split("\r\n")[0] ?? ""));
      socket.on("error", () => done(text.split("\r\n")[0] ?? ""));
    });

  const editor = () => `animaquill.localhost:${port}`;

  test("says 503 for /api while the backend is starting, and its page says it is there", async () => {
    api = undefined;
    expect((await send(editor(), "/api/health")).status).toBe(503);
    const page = await send(editor(), "/p/abc");
    expect(page.body).toContain(`<head>${BACKEND_META}<title>`);
  });

  test("hands /api of the editor's site to the backend, whatever the method", async () => {
    api = {
      request: (incoming, response) => {
        reached.push(`${incoming.method} ${incoming.url}`);
        response.writeHead(200).end("api");
      },
      upgrade: (incoming, socket) => {
        upgraded.push(incoming.url ?? "");
        socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
      },
    };
    expect(await send(editor(), "/api/projects")).toEqual({ status: 200, body: "api" });
    expect(await send(editor(), "/api/local/session", "POST")).toEqual({
      status: 200,
      body: "api",
    });
    expect(reached).toEqual(["GET /api/projects", "POST /api/local/session"]);
    // What is not /api stays the server's own.
    expect((await send(editor(), "/apiary")).status).toBe(404);
    expect((await send(editor(), "/", "POST")).status).toBe(405);
  });

  test("never on the other sites, nor on this computer by another name", async () => {
    reached.length = 0;
    expect((await send(`animaquill-sandbox.localhost:${port}`, "/api/health")).status).toBe(404);
    expect((await send(`animaquill-scene-3.localhost:${port}`, "/api/health")).status).toBe(404);
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`])
      expect((await send(host, "/api/health")).status).toBe(421);
    expect((await send(`evil.example:${port}`, "/api/health")).status).toBe(421);
    expect(reached).toEqual([]);
  });

  test("takes a WebSocket only to /api of the editor's site", async () => {
    upgraded.length = 0;
    expect(await upgrade(editor(), "/api/sync")).toBe("HTTP/1.1 101 Switching Protocols");
    for (const [host, path] of [
      [`animaquill-scene-1.localhost:${port}`, "/api/sync"],
      [`localhost:${port}`, "/api/sync"],
      [editor(), "/elsewhere"],
    ] as const)
      expect(await upgrade(host, path)).toBe("HTTP/1.1 404 Not Found");
    expect(upgraded).toEqual(["/api/sync"]);
  });
});
