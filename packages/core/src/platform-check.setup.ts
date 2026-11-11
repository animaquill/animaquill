/**
 * Every change that the tests make to a project goes through what a platform checks a change with,
 * as it would take it: `checkUpdate`, a copy that takes it in (`applyChecked`) and `checkWritten`
 * for every key it writes. None may be turned away: the editor and a platform keep to the same
 * rules, or a change that the editor made could never sync. Run with `pnpm test:platform`, see
 * vitest.platform.config.ts: the tests of all packages, each with this in front.
 *
 * Only documents of projects count, and only what tests write through the editor: `ON_PURPOSE`
 * names the tests that write into a document by hand what no editor writes, to see that the editor
 * copes with it.
 */
import { afterAll, expect } from "vitest";
import * as Y from "yjs";
import { checkWritten } from "./check-change.ts";
import { ProjectStore } from "./store.ts";
import { checkUpdate } from "./sync.ts";

/** Pieces a change may have on the platform, as `SYNC_LIMITS.structs` of @animaquill/host says. */
const MOST = 200_000;

/** Tests that write by hand what no editor writes, on purpose: the platform has to turn it away. */
const ON_PURPOSE: readonly RegExp[] = [
  /does not take a name that means something to objects for a property/,
  /what a document can hold that nothing should/,
  /says what stayed out when part of the project is not valid/,
  /does not let a path a zip file cannot have stop the export/,
  /takes what a page from back then writes the way it did, as long as it is not large/,
  /say so at the export already when they are too large to come back/,
];

const SHADOW = Symbol("shadow");
type Doc = Y.Doc & { [SHADOW]?: true };

/** The copy that each document of a project has on the platform, or null for one that is none. */
const shadows = new WeakMap<Y.Doc, ProjectStore | null>();
/** What a document had before its first change that the tests made. */
const before = new WeakMap<Y.Doc, Uint8Array>();
const faults: { readonly test: string; readonly fault: string }[] = [];
let checked = 0;
let inside = false;

const emit = Y.Doc.prototype.emit as (this: Y.Doc, name: string, args: unknown[]) => void;

/**
 * A document that is no part of the test: it takes none of the client ids that a test can seed (see
 * `seedIds` of fuzz-support.ts), so that a seed goes the same way with these checks as without.
 */
function unseededDoc(): Doc {
  const seeded = Object.getOwnPropertyDescriptor(Y.Doc.prototype, "clientID");
  if (seeded) Reflect.deleteProperty(Y.Doc.prototype, "clientID");
  try {
    return new Y.Doc() as Doc;
  } finally {
    if (seeded) Object.defineProperty(Y.Doc.prototype, "clientID", seeded);
  }
}

const copyOf = (parts: readonly Uint8Array[]): ProjectStore => {
  const doc = unseededDoc();
  doc[SHADOW] = true;
  for (const part of parts) Y.applyUpdate(doc, part);
  return new ProjectStore(doc);
};

const isProject = (store: ProjectStore) => {
  try {
    return typeof store.getState().manifest?.id === "string";
  } catch {
    return false;
  }
};

/** The copy of a document, made the first time it changes: undefined where this change made it. */
function shadowOf(doc: Y.Doc, update: Uint8Array): ProjectStore | null | undefined {
  const known = shadows.get(doc);
  if (known !== undefined) return known;
  const first = copyOf([before.get(doc) ?? new Uint8Array([0, 0])]);
  if (isProject(first)) {
    shadows.set(doc, first);
    return first;
  }
  // The change that made the project: from here on, what changes it counts.
  first.destroy();
  const made = copyOf([before.get(doc) ?? new Uint8Array([0, 0]), update]);
  shadows.set(doc, isProject(made) ? made : null);
  return undefined;
}

function check(doc: Y.Doc, update: Uint8Array): void {
  const shadow = shadowOf(doc, update);
  if (!shadow) return;
  checked += 1;
  const fault = checkUpdate(update, { most: MOST });
  if (fault) throw new Error(`the change: ${fault}`);
  const change = shadow.applyChecked(update, "platform");
  if (shadow.isMissingUpdates) throw new Error("it needs a change the platform does not have");
  for (const written of change.written) {
    const wrong = checkWritten(written.path, written.raw);
    if (wrong) throw new Error(`${wrong.problem} at ${wrong.path}`);
  }
}

Y.Doc.prototype.emit = function (this: Doc, name: string, args: unknown[]) {
  if (!inside && !this[SHADOW]) {
    inside = true;
    try {
      if (name === "beforeTransaction" && !before.has(this) && !shadows.has(this)) {
        before.set(this, Y.encodeStateAsUpdate(this));
        // Without a listener, Yjs makes no update of a change.
        this.on("update", () => {});
      } else if (name === "update") {
        check(this, args[0] as Uint8Array);
      }
    } catch (error) {
      const test = expect.getState().currentTestName ?? "(outside of a test)";
      faults.push({ test, fault: error instanceof Error ? error.message : String(error) });
    } finally {
      inside = false;
    }
  }
  emit.call(this, name, args);
};

afterAll(() => {
  const turnedAway = faults.filter(({ test }) => !ON_PURPOSE.some((pattern) => pattern.test(test)));
  expect(turnedAway, `${checked} changes checked`).toEqual([]);
});
