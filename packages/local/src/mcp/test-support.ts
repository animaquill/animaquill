import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadFixture } from "../../../schema/scripts/fixture.ts";

const made: string[] = [];

/** A new folder of its own, taken away by `cleanUp`. */
export function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "animaquill-mcp-"));
  made.push(folder);
  return folder;
}

/**
 * The sample project in a folder of its own, without the tag that locks it, so that it can be
 * changed. Resolves to the folder.
 */
export function sampleFolder(inside: string = tempFolder()): string {
  const files = loadFixture("v1");
  const manifest = JSON.parse(files.get("animaquill.json") as string) as Record<string, unknown>;
  delete manifest.tags;
  files.set("animaquill.json", `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [path, text] of files) {
    const place = join(inside, path);
    mkdirSync(dirname(place), { recursive: true });
    writeFileSync(place, text);
  }
  return inside;
}

export function cleanUp(): void {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
}
