import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Rollup } from "vite";

const ENTRY = fileURLToPath(new URL("./runtime/main.ts", import.meta.url));

export interface RuntimeBundle {
  /** One classic script, which is what the scene page runs. */
  readonly code: string;
  /** What it was made from. */
  readonly files: readonly string[];
}

/**
 * The notices that have to go along with what got bundled. Minifying takes comments out, and these
 * licenses all ask for the notice to stay with every copy, so they get read from the packages.
 */
function licenseNotices(files: readonly string[]): string {
  const packages = new Set<string>();
  for (const file of files) {
    const root = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1];
    if (root) packages.add(root);
  }
  const notices = [...packages].toSorted().map((root) => {
    const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly name: string;
      readonly version: string;
    };
    const license = readdirSync(root).find((file) => /^licen[cs]e/i.test(file));
    if (!license) throw new Error(`${name} has no license file to go along with the runtime`);
    return `${name} ${version}\n\n${readFileSync(join(root, license), "utf8").trim()}`;
  });
  return `/*!\n${notices.join("\n\n---\n\n").replaceAll("*/", "* /")}\n*/\n`;
}

/**
 * Makes the runtime into one script. Scenes get it as text, in a message, so it cannot be a set of
 * modules, and it needs a bundler the way a web worker does.
 */
export async function bundleRuntime({ minify = true } = {}): Promise<RuntimeBundle> {
  const output = (await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify,
      emptyOutDir: false,
      lib: {
        entry: ENTRY,
        formats: ["iife"],
        name: "animaquillSceneRuntime",
        fileName: () => "scene-runtime.js",
      },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const [result] = Array.isArray(output) ? output : [output];
  const chunk = result?.output.find(
    (file): file is Rollup.OutputChunk => file.type === "chunk" && file.isEntry,
  );
  if (!chunk) throw new Error("The runtime did not build");
  const files = Object.keys(chunk.modules);
  return { code: licenseNotices(files) + chunk.code, files };
}
