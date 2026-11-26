import { cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scenePageTemplate } from "@animaquill/web/vite";
import { defineConfig } from "vite";
import { thirdPartyLicenses } from "./vite-plugins/licenses.ts";

/**
 * The server, with what it takes from the other packages, as files that Node runs as they are:
 * the package depends on nothing but the PostgreSQL of its platform (backend/postgres.ts). Next to
 * them the scene page (see src/server.ts), the migrations of the backend's database, and the two
 * threads the backend starts (`copy-worker`, `export-worker`), each an entry of its own: their
 * sources name themselves with `.ts`, the build with `.js`.
 */

const server = (path: string) => fileURLToPath(new URL(`../server/src/${path}`, import.meta.url));

export default defineConfig({
  build: {
    ssr: true,
    outDir: "dist",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      input: {
        cli: "src/bin.ts",
        "copy-worker": server("sync/copy-worker.ts"),
        "export-worker": server("archive/export-worker.ts"),
      },
      // `pg` asks for its native binding only where told to, which nothing here does.
      external: ["pg-native"],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
        banner: (chunk) => (chunk.name === "cli" ? "#!/usr/bin/env node" : ""),
      },
    },
  },
  ssr: { noExternal: true },
  plugins: [
    thirdPartyLicenses(),
    {
      name: "animaquill-threads",
      transform(code, id) {
        if (!id.includes("/packages/server/src/")) return null;
        const next = code
          .replace(
            'new URL("./copy-worker.ts", import.meta.url)',
            'new URL("./copy-worker.js", import.meta.url)',
          )
          .replace(
            'new URL("./export-worker.ts", import.meta.url)',
            'new URL("./export-worker.js", import.meta.url)',
          );
        return next === code ? null : next;
      },
    },
    {
      name: "animaquill-scene-page-template",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "scene.html", source: scenePageTemplate() });
      },
    },
    {
      name: "animaquill-migrations",
      writeBundle() {
        cpSync(server("drizzle"), fileURLToPath(new URL("dist/drizzle", import.meta.url)), {
          recursive: true,
        });
      },
    },
  ],
});
