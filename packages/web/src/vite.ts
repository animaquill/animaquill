import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_PAGE_PATH, scenePage } from "@animaquill/scene/policy";
import { sceneRuntime } from "@animaquill/scene/vite";
import react from "@vitejs/plugin-react";
import type { Plugin, PluginOption } from "vite";
import type { Sites } from "./sites.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The pages every deployment has, the same everywhere, with what differs coming in as modules. */
const PAGES = ["index.html", "compositor.html"] as const;

/** Icons, the manifest and what an installed app needs, served as they are. */
export const PUBLIC = here("../public");

/** Where the pages ask for the module of the deployment, and for the compositor. */
const MAIN = "/@animaquill/main";
const COMPOSITOR = "/@animaquill/compositor";

/** The page scenes run on, as it comes, before a deployment says who may use it. */
export const scenePageTemplate = () =>
  readFileSync(createRequire(import.meta.url).resolve("@animaquill/scene/page"), "utf8");

export interface WebAppOptions {
  /** The module that starts the editor on the page, with `startEditor`, relative to the root. */
  readonly main: string;
  /**
   * The sites, when they are known as it builds. Then the build has the scene page for them. A
   * server that learns its sites only as it starts makes the page itself, see `scenePage`.
   */
  readonly sites?: Sites;
  /** Off for builds that only tests use: errors are easier to read, and it builds faster. */
  readonly minify?: boolean;
}

/**
 * Builds the editor as a web app: its page and the compositor's, from this package, with the module
 * of the deployment in the editor's page. Each deployment only says what it adds.
 */
export function webApp(options: WebAppOptions): PluginOption[] {
  let root = process.cwd();
  const pageAt = (id: string) => PAGES.find((name) => id === resolve(root, name));
  const pageText = (name: string) => readFileSync(here(`../pages/${name}`), "utf8");

  const pages: Plugin = {
    name: "animaquill-web-app",
    enforce: "pre",
    config(config) {
      root = resolve(config.root ?? process.cwd());
      return {
        publicDir: PUBLIC,
        build: { rolldownOptions: { input: PAGES.map((name) => resolve(root, name)) } },
      };
    },
    resolveId(id) {
      if (pageAt(id)) return id;
      if (id === MAIN) return resolve(root, options.main);
      if (id === COMPOSITOR) return here("compositor.ts");
      return undefined;
    },
    load(id) {
      const name = pageAt(id);
      return name && pageText(name);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split("?")[0];
        const name = path === "/" ? "index.html" : PAGES.find((page) => path === `/${page}`);
        if (!name) {
          next();
          return;
        }
        server
          .transformIndexHtml(path as string, pageText(name))
          .then((html) => {
            response.setHeader("Content-Type", "text/html; charset=utf-8");
            response.end(html);
          })
          .catch(next);
      });
    },
    generateBundle() {
      const { sites } = options;
      if (!sites) return;
      this.emitFile({
        type: "asset",
        fileName: SCENE_PAGE_PATH.slice(1),
        source: scenePage(scenePageTemplate(), [sites.editor]),
      });
    },
  };

  return [
    react(),
    sceneRuntime(options.minify === undefined ? undefined : { minify: options.minify }),
    pages,
  ];
}
