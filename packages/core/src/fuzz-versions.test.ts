import { readProject } from "@animaquill/schema";
import { describe, expect, it } from "vitest";
import {
  FUZZ,
  openUnlocked,
  randomFrom,
  replica,
  seedIds,
  sync,
  type Random,
} from "./fuzz-support.ts";
import { deepEqual, getIn } from "./patch.ts";
import { ProjectStore, USER, aiTask, type Origin } from "./store.ts";

/** Versions that are there in the example, and some that are not: few, so both start the same. */
const VERSIONS = [
  "format.vertical",
  "language.en",
  "language.fr",
  "version.en.vertical",
  "format.sq",
];
const LANGUAGES = ["en", "fr", "de"];
/** Clips on tracks that are not locked, with or without changes in the example. */
const CLIPS = ["clip_title", "clip_logo", "clip_card", "clip_interview", "clip_voice"];

const scopeOf = (name: string) => {
  const [kind, first, second] = name.split(".");
  if (kind === "language") return { language: first };
  return kind === "format" ? { format: first } : { language: first, format: second };
};

/**
 * What one device writes, and the other never does, so that the last write of each is what has to
 * be there in the end. Both write sections, clips and strings, so that the first of a version, of
 * its sections, of the changes of a clip and of a language often comes from both at once.
 */
interface Own {
  readonly sections: readonly string[];
  readonly field: "hidden" | "offset";
  readonly property: "opacity" | "transform.x";
  readonly strings: string;
}

const OWN: readonly Own[] = [
  {
    sections: ["section_intro", "section_end"],
    field: "hidden",
    property: "opacity",
    strings: "a",
  },
  { sections: ["section_body"], field: "offset", property: "transform.x", strings: "b" },
];

function rewrite(store: ProjectStore, path: string, origin: Origin, change: (file: any) => void) {
  const text = store.exportFiles().files.get(path);
  const document = text === undefined ? {} : JSON.parse(text);
  change(document);
  return store.importFile(path, JSON.stringify(document), { origin });
}

/** Writes or takes away one thing of its own. Returns where it is in the state, and what is there. */
function writeOwn(store: ProjectStore, own: Own, random: Random, origin: Origin) {
  const away = random.chance(0.25);
  if (random.chance(0.4)) {
    const language = random.pick(LANGUAGES) as string;
    const key = `${own.strings}.${random.int(3)}`;
    const text = { text: `${key} ${random.int(1000)}` };
    const result = rewrite(store, `locales/${language}.json`, origin, (file) => {
      file.strings ??= {};
      if (away) delete file.strings[key];
      else file.strings[key] = text;
    });
    return { result, path: ["locales", language, key], value: away ? undefined : text };
  }
  const name = random.pick(VERSIONS) as string;
  const clip = random.pick(CLIPS) as string;
  const roll = random.int(3);
  const where =
    roll === 0
      ? ["sections", random.pick(own.sections) as string]
      : roll === 1
        ? ["clips", clip, own.field]
        : ["clips", clip, "properties", own.property];
  const fresh =
    roll === 0
      ? { duration: { value: String(1 + random.int(9)) } }
      : roll === 1
        ? { value: own.field === "hidden" ? random.chance(0.5) : String(random.int(5)) }
        : { value: own.property === "opacity" ? random.int(100) / 100 : random.int(500) };
  const result = rewrite(store, `timelines/main/overrides/${name}.json`, origin, (file) => {
    file.scope ??= scopeOf(name);
    let level = file;
    for (const key of where.slice(0, -1)) level = level[key] ??= {};
    if (away) delete level[where.at(-1) as string];
    else level[where.at(-1) as string] = fresh;
  });
  const path = ["timelines", "main", "overrides", name, ...where];
  return { result, path, value: away ? undefined : fresh };
}

const pickOrigin = (random: Random) => (random.chance(0.3) ? aiTask(`t${random.int(2)}`) : USER);

describe.each([1, 2, 3, 4, 5, 6, 7, 8])(
  "two devices, each with its own changes of versions and strings, seed %i",
  FUZZ,
  (seed) => {
    it("never loses what either of them wrote", () => {
      seedIds(seed);
      const random = randomFrom(seed);
      const a = openUnlocked();
      const b = replica(a);
      const wrote = new Map<
        string,
        { readonly path: readonly string[]; readonly value: unknown }
      >();
      let firsts = 0;

      for (let round = 0; round < 160; round++) {
        const side = random.int(2);
        const store = side === 0 ? a : b;
        const before = store.getState();
        const { result, path, value } = writeOwn(
          store,
          OWN[side] as Own,
          random,
          pickOrigin(random),
        );
        expect(result.ok, JSON.stringify(result.ok || result.error)).toBe(true);
        if (!result.ok) continue;
        // The first of its level on this side, which is where two maps would have fought.
        if (getIn(before, path.slice(0, -1)) === undefined) firsts += 1;
        wrote.set(path.join("\n"), { path, value });
        if (random.chance(0.04)) sync(a, b);
      }

      sync(a, b);
      sync(a, b);
      expect(firsts).toBeGreaterThan(10);
      for (const store of [a, b]) {
        for (const { path, value } of wrote.values()) {
          expect(getIn(store.getState(), path), path.join("/")).toEqual(value);
        }
      }
      expect(deepEqual(a.getState(), b.getState())).toBe(true);
      expect(a.exportFiles().files).toEqual(b.exportFiles().files);
      expect(deepEqual(new ProjectStore(a.doc).getState(), a.getState())).toBe(true);
    });

    it("converges with undo and redo, and always gives valid files", () => {
      seedIds(seed);
      const random = randomFrom(seed);
      const a = openUnlocked();
      const b = replica(a);

      for (let round = 0; round < 200; round++) {
        const side = random.int(2);
        const store = side === 0 ? a : b;
        const roll = random.int(100);
        if (roll < 12) store.undo();
        else if (roll < 18) store.redo();
        else if (roll < 22) store.undoTask(`t${random.int(2)}`);
        else if (roll < 28) {
          // A language whose strings all go at once, which stays there without any.
          const language = random.pick(LANGUAGES) as string;
          const empty = JSON.stringify({ strings: {} });
          store.importFile(`locales/${language}.json`, empty, { origin: pickOrigin(random) });
        } else writeOwn(store, OWN[side] as Own, random, pickOrigin(random));
        if (random.chance(0.15)) sync(a, b);
        // What every change leaves is what reading the document again gives.
        if (round % 10 === 0) {
          expect(deepEqual(new ProjectStore(store.doc).getState(), store.getState())).toBe(true);
        }

        if (round % 25 === 0) {
          const { files, problems } = store.exportFiles();
          expect(problems).toEqual([]);
          const errors = readProject(files).problems.filter(({ severity }) => severity === "error");
          expect(errors).toEqual([]);
        }
      }

      sync(a, b);
      sync(a, b);
      expect(deepEqual(a.getState(), b.getState())).toBe(true);
      expect(a.exportFiles().files).toEqual(b.exportFiles().files);
      expect(a.exportFiles().problems).toEqual([]);
      expect(deepEqual(new ProjectStore(a.doc).getState(), a.getState())).toBe(true);
      const { store: opened } = ProjectStore.fromUpdates([a.encodeState()]);
      expect(opened?.exportFiles().files).toEqual(a.exportFiles().files);
    });
  },
);
