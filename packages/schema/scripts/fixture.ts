import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** The files of a fixture project, as a project folder would hand them over. */
export function loadFixture(name: string): Map<string, string> {
  const root = join(FIXTURES, name);
  const files = new Map<string, string>();
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.set(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"));
    }
  };
  walk(root);
  return files;
}
