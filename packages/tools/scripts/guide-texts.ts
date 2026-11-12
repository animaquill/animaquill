/**
 * Writes src/guide/texts.ts from the two public documents that aq_guide gives AI: the project
 * format and the scene runtime. Run it with `pnpm --filter @animaquill/tools guide-texts` after
 * changing either of them; a test says when they differ.
 */
import { readFileSync, writeFileSync } from "node:fs";

const here = new URL("../", import.meta.url);
const read = (name: string) => readFileSync(new URL(`../../docs/${name}`, here), "utf8");
const text = [
  "// Made by scripts/guide-texts.ts from docs/project-format.md and docs/scene-runtime.md: do not edit.",
  `export const PROJECT_FORMAT = ${JSON.stringify(read("project-format.md"))};`,
  `export const SCENE_RUNTIME = ${JSON.stringify(read("scene-runtime.md"))};`,
  "",
].join("\n");
writeFileSync(new URL("src/guide/texts.ts", here), text);
