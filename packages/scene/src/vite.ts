import type { Plugin } from "vite";
import { bundleRuntime } from "./bundle.ts";

const RUNTIME = "virtual:animaquill-scene-runtime";
const RESOLVED = `\0${RUNTIME}`;

/** Gives the compositor the runtime as a string: `import code from "virtual:animaquill-scene-runtime"`. */
export function sceneRuntime(options?: { readonly minify?: boolean }): Plugin {
  return {
    name: "animaquill-scene-runtime",
    resolveId: (id) => (id === RUNTIME ? RESOLVED : undefined),
    async load(id) {
      if (id !== RESOLVED) return undefined;
      const { code, files } = await bundleRuntime(options);
      for (const file of files) if (!file.startsWith("\0")) this.addWatchFile(file);
      return `export default ${JSON.stringify(code)};`;
    },
  };
}
