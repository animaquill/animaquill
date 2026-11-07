import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_PAGE_PATH, scenePage, scenePolicyHeader } from "@animaquill/scene";
import { sceneRuntime } from "@animaquill/scene/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, searchForWorkspaceRoot, type Connect, type Plugin } from "vite";

const EDITOR = "http://localhost:5173";

/** Where the files of Monaco are, which is outside of this workspace in a clone with a parent. */
const monaco = resolve(
  dirname(createRequire(import.meta.url).resolve("monaco-editor/editor/editor.api.js")),
  "../../..",
);

/**
 * The page scenes run on, with the same policy as on a real site. The other sites have none here, so
 * a policy of theirs that is wrong only shows on a deployment. The same on the server of a build,
 * which the browser tests use.
 */
function scenePageOnEveryHost(): Plugin {
  const path = createRequire(import.meta.url).resolve("@animaquill/scene/page");
  const serve = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== SCENE_PAGE_PATH) {
        next();
        return;
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader("Content-Security-Policy", scenePolicyHeader());
      response.end(scenePage(readFileSync(path, "utf8"), [EDITOR]));
    });
  };
  return { name: "animaquill-scene-page", configureServer: serve, configurePreviewServer: serve };
}

const page = (name: string) => fileURLToPath(new URL(`dev/${name}`, import.meta.url));

/** The server of the development page, and of its build. */
const server = {
  host: "0.0.0.0",
  port: 5173,
  strictPort: true,
  // The compositor runs in a sandbox with no origin of its own, so its modules need CORS.
  cors: true,
};

/**
 * Runs the editor on its own, for working on the interface and for the browser tests. The tests
 * run on a build of this page, `vite build && vite preview`, see playwright.config.ts.
 */
export default defineConfig({
  root: "dev",
  plugins: [react(), sceneRuntime({ minify: false }), scenePageOnEveryHost()],
  // Found only once a file opens, which would make the server reload every page it serves.
  optimizeDeps: {
    include: [
      "monaco-editor/nls/lang/zh-cn.js",
      "monaco-editor/editor/editor.api.js",
      "monaco-editor/internal/common/workers.js",
      "monaco-editor/languages/definitions/css/register.js",
      "monaco-editor/languages/definitions/html/register.js",
      "monaco-editor/languages/definitions/javascript/register.js",
      "monaco-editor/language/css/monaco.contribution.js",
      "monaco-editor/language/html/monaco.contribution.js",
      "monaco-editor/languages/features/typescript/register.js",
    ],
  },
  server: { ...server, fs: { allow: [searchForWorkspaceRoot(process.cwd()), monaco] } },
  preview: server,
  build: {
    // Next to the page and not in it: `dev/` is source.
    outDir: "../dist",
    emptyOutDir: true,
    rolldownOptions: { input: ["index.html", "compositor.html"].map(page) },
    // Only for tests: errors are easier to read, and it builds faster.
    minify: false,
    chunkSizeWarningLimit: 10_000,
  },
});
