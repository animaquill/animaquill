import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SCENE_PAGE_PATH, scenePage, scenePolicyHeader } from "@animaquill/scene";
import { sceneRuntime } from "@animaquill/scene/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const EDITOR = "http://localhost:5173";

/**
 * The page scenes run on, with the same policy as on a real site. The other sites have none here, so
 * a policy of theirs that is wrong only shows on a deployment.
 */
function scenePageOnEveryHost(): Plugin {
  const path = createRequire(import.meta.url).resolve("@animaquill/scene/page");
  return {
    name: "animaquill-scene-page",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== SCENE_PAGE_PATH) {
          next();
          return;
        }
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Content-Security-Policy", scenePolicyHeader());
        response.end(scenePage(readFileSync(path, "utf8"), [EDITOR]));
      });
    },
  };
}

/** Runs the editor on its own, for working on the interface and for the browser tests. */
export default defineConfig({
  root: "dev",
  plugins: [react(), sceneRuntime({ minify: false }), scenePageOnEveryHost()],
  // The compositor runs in a sandbox with no origin of its own, so its modules need CORS.
  server: { host: "0.0.0.0", port: 5173, strictPort: true, cors: true },
});
