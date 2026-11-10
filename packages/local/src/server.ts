import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative } from "node:path";
import { SCENE_PAGE_PATH, scenePage } from "@animaquill/scene/policy";
import {
  CACHE,
  COMPOSITOR_PAGE,
  localSites,
  siteHeaders,
  type SiteHeaders,
  type Sites,
} from "@animaquill/web/sites";

/**
 * The server of the editor on this computer: the files of the built site, each site with the
 * headers it has wherever the editor is deployed, see `siteHeaders`. Which site a request is for
 * comes from its `Host`, because every site is a name under `localhost` at the same port.
 */

export interface LocalServerOptions {
  /** The folder of the built site. */
  readonly site: string;
  /** The scene page as it comes, from `@animaquill/scene/page`. */
  readonly scenePage: string;
  readonly port: number;
}

/** Which of the sites a request is for, by its `Host`. */
export type Destination =
  | { readonly site: "editor" | "compositor" | "scene" }
  /** This computer by another name, such as `localhost`, which leads to the editor. */
  | { readonly site: "loopback" };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Where a request goes, or nowhere. Names that are not ours get nothing: a page of some other site
 * could have its own name lead to this computer and read the editor from there otherwise.
 */
export function destinationOf(host: string | undefined, sites: Sites): Destination | undefined {
  if (!host) return undefined;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return undefined;
  }
  if (url.host !== host.toLowerCase()) return undefined;
  const { origin } = url;
  if (origin === sites.editor) return { site: "editor" };
  if (origin === sites.compositor) return { site: "compositor" };
  if (sites.scenes.includes(origin)) return { site: "scene" };
  const port = new URL(sites.editor).port;
  if (LOOPBACK.has(url.hostname) && url.port === port) return { site: "loopback" };
  return undefined;
}

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** Headers every answer has. */
const ALWAYS = { "X-Content-Type-Options": "nosniff" };

/** The path of a request, or undefined for one that is not a plain path in the site. */
export function pathOf(url: string | undefined): string | undefined {
  if (!url?.startsWith("/")) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(new URL(url, "http://x").pathname);
  } catch {
    return undefined;
  }
  if (path.includes("\0") || path.includes("\\")) return undefined;
  if (path.split("/").some((part) => part === "..")) return undefined;
  return path;
}

/** The headers a file of the site gets on a site. */
function headersFor(
  site: "editor" | "compositor",
  path: string,
  headers: SiteHeaders,
): Record<string, string> {
  const hashed = site === "editor" && path.startsWith("/assets/");
  return {
    ...headers[site],
    "Cache-Control": hashed ? CACHE.hashed : CACHE.plain,
  };
}

/** Which files the compositor's site has: its page and the code, and nothing else. */
const compositorHas = (path: string) =>
  path === COMPOSITOR_PAGE || (path.startsWith("/assets/") && !path.endsWith(".map"));

function answer(
  response: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, {
    ...ALWAYS,
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": CACHE.plain,
    ...headers,
  });
  response.end(text);
}

async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  path: string,
  headers: Record<string, string>,
) {
  const file = join(root, path === "/" ? "index.html" : path);
  const inside = relative(root, file);
  if (inside.startsWith("..") || isAbsolute(inside) || file.endsWith(".map")) {
    answer(response, 404, "Not found");
    return;
  }
  let size: number;
  try {
    const found = await stat(file);
    if (!found.isFile()) throw new Error("Not a file");
    size = found.size;
  } catch {
    answer(response, 404, "Not found");
    return;
  }
  response.writeHead(200, {
    ...ALWAYS,
    ...headers,
    "Content-Type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": String(size),
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

/** Answers the requests of all sites. */
export function localHandler(options: LocalServerOptions, sites: Sites = localSites(options.port)) {
  const headers = siteHeaders(sites);
  const scene = scenePage(options.scenePage, [sites.editor]);
  return (request: IncomingMessage, response: ServerResponse): void => {
    const destination = destinationOf(request.headers.host, sites);
    if (!destination) {
      answer(response, 421, "This server only answers for the editor on this computer");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      answer(response, 405, "Method not allowed", { Allow: "GET, HEAD" });
      return;
    }
    const path = pathOf(request.url);
    if (path === undefined) {
      answer(response, 400, "Bad request");
      return;
    }
    switch (destination.site) {
      case "loopback": {
        // Only the editor's own name gets its storage, so `localhost` leads there, never in place.
        // Only the path and the query: an address like `//elsewhere/` must not lead elsewhere.
        const { pathname, search } = new URL(request.url ?? "/", "http://x");
        const target = `${sites.editor}${pathname}${search}`;
        answer(response, 302, `See ${target}`, { Location: target });
        return;
      }
      case "scene": {
        if (path !== SCENE_PAGE_PATH) {
          answer(response, 404, "Not found");
          return;
        }
        response.writeHead(200, {
          ...ALWAYS,
          ...headers.scene,
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": CACHE.plain,
        });
        response.end(request.method === "HEAD" ? undefined : scene);
        return;
      }
      case "compositor":
        if (!compositorHas(path)) {
          answer(response, 404, "Not found");
          return;
        }
        void sendFile(
          request,
          response,
          options.site,
          path,
          headersFor("compositor", path, headers),
        );
        return;
      case "editor":
        void sendFile(request, response, options.site, path, headersFor("editor", path, headers));
        return;
    }
  };
}

/** The port is taken, by another program or another copy of this one. */
export class PortInUse extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is in use`);
  }
}

export interface LocalServer {
  readonly sites: Sites;
  close(): Promise<void>;
}

/** Errors that only say this computer has no IPv6 loopback. */
const NO_ADDRESS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

function listen(server: Server, port: number, address: string): Promise<boolean> {
  return new Promise((done, fail) => {
    const failed = (error: NodeJS.ErrnoException) => {
      server.off("listening", listening);
      if (error.code === "EADDRINUSE") fail(new PortInUse(port));
      else if (address === "::1" && error.code && NO_ADDRESS.has(error.code)) done(false);
      else fail(error);
    };
    const listening = () => {
      server.off("error", failed);
      done(true);
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen({ port, host: address, exclusive: true });
  });
}

const closeAll = (servers: readonly Server[]) =>
  Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
    ),
  ).then(() => undefined);

/**
 * Starts the server on the loopback addresses of this computer and nowhere else. Browsers take names
 * under `localhost` to either loopback, so it listens on both, and fails when either is taken: what
 * answers there would get the editor's storage.
 */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const sites = localSites(options.port);
  const handler = localHandler(options, sites);
  const servers: Server[] = [];
  try {
    for (const address of ["127.0.0.1", "::1"]) {
      const server = createServer(handler);
      if (await listen(server, options.port, address)) servers.push(server);
    }
  } catch (error) {
    await closeAll(servers);
    throw error;
  }
  return { sites, close: () => closeAll(servers) };
}
