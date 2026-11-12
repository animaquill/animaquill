/**
 * Checks a model pack the way the editor does when people install it, and runs its examples on the
 * sample project too: `pnpm --filter @animaquill/tools pack-check <folder or pack.json>`. Prints
 * what does not pass, what the install dialog will mark, and how large the words come out. See
 * docs/model-packs.md. With `--keys` instead, it lists every key a pack can have words for, with the
 * default words.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ProjectStore } from "@animaquill/core";
import { loadFixture } from "../../schema/scripts/fixture.ts";
import {
  MAX_FILE_BYTES,
  checkPack,
  filesNamedIn,
  isPackPath,
  packKeys,
  textsOf,
  usePack,
} from "../src/packs/index.ts";
import { DEFAULT_TEXTS, systemPromptOf } from "../src/texts/index.ts";
import { createToolset } from "../src/toolset.ts";

const given = process.argv[2];
if (given === "--keys") {
  // Every key a pack can have words for, with the default words, as the tools are now.
  for (const [key, kind] of packKeys()) {
    const value = DEFAULT_TEXTS[key];
    console.log(
      `${key}${kind === "examples" ? " (examples)" : ""}\n  ${JSON.stringify(value ?? "")}`,
    );
  }
  process.exit(0);
}
if (!given) {
  console.error("Usage: pnpm --filter @animaquill/tools pack-check <folder or pack.json>");
  process.exit(2);
}
// pnpm runs this in the package: paths are where people called it from.
const where = resolve(process.env.INIT_CWD ?? process.cwd(), given);
const folder = statSync(where).isDirectory() ? where : dirname(where);
const manifest = statSync(where).isDirectory() ? join(where, "pack.json") : where;
const files = new Map<string, Uint8Array>();
/** A file of the pack, only where it is one: a plain file, not much larger than a pack may have. */
const read = (path: string) => {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES * 2) return undefined;
    return new Uint8Array(readFileSync(path));
  } catch {
    return undefined;
  }
};
const own = read(manifest);
if (own) files.set("pack.json", own);
// Only paths inside the pack, of the kinds it may have: the check says why the others are not.
for (const path of filesNamedIn(new TextDecoder().decode(own ?? new Uint8Array()))) {
  if (!isPackPath(path)) continue;
  const bytes = read(join(folder, path));
  if (bytes) files.set(path, bytes);
}

const sample = () => {
  const project = loadFixture("v1");
  const json = JSON.parse(project.get("animaquill.json") as string);
  delete json.tags;
  project.set("animaquill.json", JSON.stringify(json));
  const { store } = ProjectStore.open(project);
  if (!store) throw new Error("the sample project did not open");
  return store;
};

const check = checkPack(files, { sample });
for (const problem of check.problems) {
  console.log(`not ok  ${problem.code}  ${problem.at}  ${JSON.stringify(problem.detail ?? {})}`);
}
for (const hint of check.hints) console.log(`look    ${hint.at}: ${hint.rules.join(", ")}`);
const pack = check.pack;
if (!pack) {
  console.log(`${basename(where)}: does not pass`);
  process.exit(1);
}
const host = {
  store: () => undefined,
  origin: () => "ai:pack-check",
  problems: () => {
    throw new Error("nothing runs here");
  },
};
for (const model of ["", ...pack.models]) {
  const use = usePack(pack, model || undefined);
  const tools = createToolset(host as never, undefined, textsOf(pack), { results: use.results });
  const list = JSON.stringify(
    tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  ).length;
  const prompt = systemPromptOf({ entry: "browser", texts: use.texts }).length;
  console.log(
    `${model || "(any model)"}: system prompt ${prompt} characters, tools ${list} characters, call ${JSON.stringify(use.call)}, results ${use.results}`,
  );
}
console.log(`${pack.id} ${pack.version}: passes (${pack.edits.length} changes of words)`);
