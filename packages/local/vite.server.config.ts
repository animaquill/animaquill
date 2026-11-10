import { scenePageTemplate } from "@animaquill/web/vite";
import { defineConfig } from "vite";

/**
 * The server, with what it takes from the other packages, as one file that Node runs as it is: the
 * package has no dependencies. The scene page goes next to it, see src/server.ts.
 */
export default defineConfig({
  build: {
    ssr: "src/cli.ts",
    outDir: "dist",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      output: { entryFileNames: "cli.js", banner: "#!/usr/bin/env node" },
    },
  },
  ssr: { noExternal: true },
  plugins: [
    {
      name: "animaquill-scene-page-template",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "scene.html", source: scenePageTemplate() });
      },
    },
  ],
});
