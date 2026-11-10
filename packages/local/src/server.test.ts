import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenePolicyHeader } from "@animaquill/scene/policy";
import { compositorPolicy, editorPolicy, localSites } from "@animaquill/web/sites";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PortInUse, destinationOf, localHandler, pathOf, startLocalServer } from "./server.ts";

const PORT = 7651;
const sites = localSites(PORT);
const TEMPLATE = '<!doctype html><html data-editors="[]"><title>Scene</title></html>';

describe("destinationOf", () => {
  test("knows each site by its name and port", () => {
    expect(destinationOf("animaquill.localhost:7651", sites)).toEqual({ site: "editor" });
    expect(destinationOf("animaquill-sandbox.localhost:7651", sites)).toEqual({
      site: "compositor",
    });
    for (let index = 0; index < 8; index++) {
      expect(destinationOf(`animaquill-scene-${index}.localhost:7651`, sites)).toEqual({
        site: "scene",
      });
    }
  });

  test("takes this computer by another name to the editor", () => {
    for (const host of ["localhost:7651", "127.0.0.1:7651", "[::1]:7651"]) {
      expect(destinationOf(host, sites)).toEqual({ site: "loopback" });
    }
  });

  test("answers no other name, and no other port", () => {
    for (const host of [
      undefined,
      "",
      "evil.example:7651",
      "animaquill.localhost.evil.example:7651",
      "animaquill.localhost:7652",
      "animaquill.localhost",
      "localhost:80",
      "animaquill-scene-8.localhost:7651",
      "animaquill.localhost:7651/x",
      "user@animaquill.localhost:7651",
    ]) {
      expect(destinationOf(host, sites), String(host)).toBeUndefined();
    }
  });

  test("works on the port of http, where the origin has none", () => {
    const plain = localSites(80);
    expect(destinationOf("animaquill.localhost", plain)).toEqual({ site: "editor" });
    expect(destinationOf("localhost", plain)).toEqual({ site: "loopback" });
  });
});

describe("pathOf", () => {
  test("takes plain paths", () => {
    expect(pathOf("/")).toBe("/");
    expect(pathOf("/assets/a.js?x=1")).toBe("/assets/a.js");
    expect(pathOf("/%E5%9B%BE.png")).toBe("/图.png");
  });

  test("refuses what could leave the site", () => {
    for (const url of [
      undefined,
      "",
      "x",
      "/a/%2e%2e%2f..%2fb",
      "/a%2F..%2F..%2Fb",
      "/a%00",
      "/a%5c..%5cb",
      "/%",
    ]) {
      expect(pathOf(url), String(url)).toBeUndefined();
    }
  });
});

describe("the server", () => {
  let folder: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), "animaquill-local-"));
    const site = join(folder, "site");
    mkdirSync(join(site, "assets"), { recursive: true });
    writeFileSync(join(site, "index.html"), "<!doctype html><title>AnimaQuill</title>");
    writeFileSync(join(site, "compositor.html"), "<!doctype html><title>合成器</title>");
    writeFileSync(join(site, "manifest.webmanifest"), "{}");
    writeFileSync(join(site, "assets", "index-abc.js"), "export {};");
    writeFileSync(join(site, "assets", "index-abc.js.map"), "{}");
    writeFileSync(join(folder, "secret.txt"), "secret");
    server = createServer(localHandler({ site, scenePage: TEMPLATE, port: PORT }));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(folder, { recursive: true, force: true });
  });

  /** A request as the browser makes it for a site, which all lead to this one server. */
  const get = (host: string, path: string, method = "GET") =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (done, fail) => {
        const sent = request(
          { host: "127.0.0.1", port, path, method, headers: { host } },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (part: string) => (body += part));
            response.on("end", () =>
              done({ status: response.statusCode ?? 0, headers: response.headers, body }),
            );
          },
        );
        sent.on("error", fail);
        sent.end();
      },
    );

  const EDITOR = "animaquill.localhost:7651";
  const COMPOSITOR = "animaquill-sandbox.localhost:7651";
  const SCENE = "animaquill-scene-5.localhost:7651";

  test("the editor has its page, with its policy", async () => {
    const { status, headers, body } = await get(EDITOR, "/");
    expect(status).toBe(200);
    expect(body).toContain("<title>AnimaQuill</title>");
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(headers["content-security-policy"]).toBe(editorPolicy(sites));
    expect(headers["content-security-policy"]).toContain(
      "frame-src http://animaquill-sandbox.localhost:7651;",
    );
    expect(headers["cache-control"]).toBe("no-cache");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("code is kept, as its name changes with it", async () => {
    const { status, headers } = await get(EDITOR, "/assets/index-abc.js");
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  test("the manifest has its type", async () => {
    const { headers } = await get(EDITOR, "/manifest.webmanifest");
    expect(headers["content-type"]).toBe("application/manifest+json; charset=utf-8");
  });

  test("nothing outside the site, no maps and no folders", async () => {
    for (const path of [
      "/assets/index-abc.js.map",
      "/../secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      "/assets",
      "/assets/",
      "/missing.js",
      "/scene.html",
    ]) {
      const { status, body } = await get(EDITOR, path);
      expect(status, path).toBeGreaterThanOrEqual(400);
      expect(body, path).not.toContain("secret");
    }
  });

  test("the compositor has its page and code, with its policy, and nothing else", async () => {
    const page = await get(COMPOSITOR, "/compositor.html");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toBe(compositorPolicy(sites));
    expect(page.headers["access-control-allow-origin"]).toBe("*");
    expect(page.headers["cache-control"]).toBe("no-cache");
    const code = await get(COMPOSITOR, "/assets/index-abc.js");
    expect(code.status).toBe(200);
    expect(code.headers["access-control-allow-origin"]).toBe("*");
    for (const path of [
      "/",
      "/index.html",
      "/manifest.webmanifest",
      "/assets/index-abc.js.map",
      "/scene.html",
    ]) {
      expect((await get(COMPOSITOR, path)).status, path).toBe(404);
    }
  });

  test("a scene site has the scene page for this editor, with the sandbox as its policy", async () => {
    const { status, headers, body } = await get(SCENE, "/scene.html");
    expect(status).toBe(200);
    expect(headers["content-security-policy"]).toBe(scenePolicyHeader());
    expect(headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(body).toContain('data-editors="[&quot;http://animaquill.localhost:7651&quot;]"');
    for (const path of [
      "/",
      "/index.html",
      "/compositor.html",
      "/assets/index-abc.js",
      "/scene.html/x",
    ]) {
      expect((await get(SCENE, path)).status, path).toBe(404);
    }
  });

  test("this computer by another name leads to the editor, and nowhere else", async () => {
    const plain = await get("localhost:7651", "/?a=1");
    expect(plain.status).toBe(302);
    expect(plain.headers["location"]).toBe("http://animaquill.localhost:7651/?a=1");
    const sneaky = await get("127.0.0.1:7651", "//evil.example/x");
    expect(sneaky.headers["location"]).toBe("http://animaquill.localhost:7651/x");
  });

  test("other names get nothing", async () => {
    const { status, body } = await get("evil.example:7651", "/");
    expect(status).toBe(421);
    expect(body).not.toContain("AnimaQuill<");
  });

  test("only reads", async () => {
    expect((await get(EDITOR, "/", "POST")).status).toBe(405);
    const head = await get(EDITOR, "/", "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });
});

describe("startLocalServer", () => {
  test("says when the port is taken, and leaves nothing open", async () => {
    const other = createServer();
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const { port } = other.address() as AddressInfo;
    try {
      await expect(startLocalServer({ site: tmpdir(), scenePage: TEMPLATE, port })).rejects.toEqual(
        new PortInUse(port),
      );
    } finally {
      await new Promise((done) => other.close(done));
    }
  });

  test("starts at a port that is free, and stops again", async () => {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    const { port } = probe.address() as AddressInfo;
    await new Promise((done) => probe.close(done));
    const server = await startLocalServer({ site: tmpdir(), scenePage: TEMPLATE, port });
    try {
      expect(server.sites.editor).toBe(`http://animaquill.localhost:${port}`);
    } finally {
      await server.close();
    }
  });
});
