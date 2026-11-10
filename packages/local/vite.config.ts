import { readFileSync } from "node:fs";
import { webApp } from "@animaquill/web/vite";
import { defineConfig } from "vite";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

/**
 * The site of the editor on this computer, which goes into the package as it is. The server makes
 * the scene page as it starts, when it knows its port: see src/server.ts. The server itself is
 * built by vite.server.config.ts, first, because this one empties its folder.
 */
export default defineConfig({
  plugins: [webApp({ main: "src/main.ts" })],
  define: { "import.meta.env.VITE_VERSION": JSON.stringify(version) },
  build: {
    outDir: "dist/site",
    emptyOutDir: true,
    // The code is open, and maps would only make the package bigger.
    sourcemap: false,
    // Monaco and the code of the compositor are large, and come in only when used.
    chunkSizeWarningLimit: 10_000,
  },
});
