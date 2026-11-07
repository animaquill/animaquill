import type { Plugin } from "vite";
import { bundleRuntime } from "./bundle.ts";

const RUNTIMES = {
  "virtual:animaquill-scene-runtime": "scene",
  "virtual:animaquill-sound-runtime": "sound",
} as const;

const kindOf = (id: string) => RUNTIMES[id.slice(1) as keyof typeof RUNTIMES];

/**
 * Gives the compositor the runtimes as strings: `import code from "virtual:animaquill-scene-runtime"`,
 * and the same with `sound`.
 */
export function sceneRuntime(options?: { readonly minify?: boolean }): Plugin {
  return {
    name: "animaquill-scene-runtime",
    resolveId: (id) => (id in RUNTIMES ? `\0${id}` : undefined),
    async load(id) {
      const kind = id.startsWith("\0") ? kindOf(id) : undefined;
      if (!kind) return undefined;
      const { code, files } = await bundleRuntime({ ...options, kind });
      for (const file of files) if (!file.startsWith("\0")) this.addWatchFile(file);
      return `export default ${JSON.stringify(code)};`;
    },
  };
}
