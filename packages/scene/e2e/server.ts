import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";
import { compositorFrameSource, scenePage, scenePolicyHeader } from "../src/policy.ts";
import { sceneRuntime } from "../src/vite.ts";
import { COMPOSITOR, EDITOR, OUTSIDE, PORT, SCENES } from "./hosts.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** Headers as they will be on the real sites. See the deployment for what is really sent. */
const EDITOR_POLICY = [
  "default-src 'self'",
  `frame-src ${COMPOSITOR} ${OUTSIDE}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const COMPOSITOR_POLICY = [
  "default-src 'none'",
  `script-src ${COMPOSITOR}`,
  "img-src blob:",
  "media-src blob:",
  compositorFrameSource(SCENES),
  "base-uri 'none'",
  "form-action 'none'",
  `frame-ancestors ${EDITOR}`,
].join("; ");

async function bundle(entry: string): Promise<string> {
  const output = (await build({
    configFile: false,
    logLevel: "warn",
    // Minified, because that is what goes out, and it travels as text.
    plugins: [sceneRuntime()],
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      lib: { entry: here(entry), formats: ["iife"], name: "lab", fileName: () => "out.js" },
    },
  })) as Rollup.RollupOutput[] | Rollup.RollupOutput;
  const [result] = Array.isArray(output) ? output : [output];
  const chunk = result?.output.find((file) => file.type === "chunk");
  if (chunk?.type !== "chunk") throw new Error(`Nothing came out of ${entry}`);
  return chunk.code;
}

const [editorCode, compositorCode] = await Promise.all([
  bundle("./harness/editor.ts"),
  bundle("./harness/compositor.ts"),
]);

const page = (script: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Test</title></head>` +
  `<body><script src="${script}"></script></body></html>`;

/** Every request to the outside, with what it was. This is what tests believe, not the page. */
const leaks: string[] = [];

function send(
  response: ServerResponse,
  body: string,
  type: string,
  headers: Record<string, string> = {},
) {
  response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  response.end(body);
}

const HTML = "text/html; charset=utf-8";
const JS = "text/javascript; charset=utf-8";

const server = createServer((request, response) => {
  const host = request.headers.host ?? "";
  const origin = `http://${host}`;
  const { pathname } = new URL(request.url ?? "/", origin);
  if (host === `localhost:${PORT}`) {
    if (pathname === "/leaks") {
      send(response, JSON.stringify(leaks), "application/json");
      return;
    }
    send(response, "ok", "text/plain");
    return;
  }
  if (origin === EDITOR) {
    const policy = { "Content-Security-Policy": EDITOR_POLICY };
    if (pathname === "/") send(response, page("/editor.js"), HTML, policy);
    else if (pathname === "/editor.js") send(response, editorCode, JS);
    else {
      response.writeHead(404);
      response.end();
    }
    return;
  }
  if (origin === COMPOSITOR) {
    if (pathname === "/compositor.html") {
      const policy = { "Content-Security-Policy": COMPOSITOR_POLICY };
      send(response, page(`${COMPOSITOR}/compositor.js`), HTML, policy);
    } else if (pathname === "/compositor.js") {
      send(response, compositorCode, JS, { "Access-Control-Allow-Origin": "*" });
    } else {
      response.writeHead(404);
      response.end();
    }
    return;
  }
  if ((SCENES as readonly string[]).includes(origin)) {
    if (pathname === "/scene.html") {
      const scene = scenePage(readFileSync(here("../page/scene.html"), "utf8"), [EDITOR]);
      send(response, scene, HTML, { "Content-Security-Policy": scenePolicyHeader() });
    } else {
      response.writeHead(404);
      response.end();
    }
    return;
  }
  if (origin === OUTSIDE) {
    leaks.push(`${request.method} ${request.url}`);
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": pathname.endsWith(".css") ? "text/css" : HTML,
    });
    response.end("ok");
    return;
  }
  response.writeHead(404);
  response.end();
});

server.listen(PORT, "0.0.0.0");
