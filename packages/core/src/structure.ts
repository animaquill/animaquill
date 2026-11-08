/** Where something is in a project: keys from the root down. */
export type Path = readonly string[];

type Tree = { readonly [key: string]: Tree };

const ANY = "*";
const fields: Tree = {};

/**
 * Levels that not everything has from the start, such as the properties of a clip, or what a
 * version changes. Two people who both make the first map of such a level end up with one of the two
 * maps, and whatever is in the other one is gone. So these have no map of their own: what they hold
 * sits in the nearest map above, each value under its path from there, such as `properties/opacity`
 * in a clip, or `language.en/clips/c1/hidden` in the versions of a timeline. There is nothing to
 * create, and two values can never get in each other's way.
 *
 * Documents from before this have maps here, one inside the other. `ProjectStore` reads those too.
 */
const FLAT = new WeakSet<Tree>();
const flat = (tree: Tree = {}): Tree => {
  FLAT.add(tree);
  return tree;
};

const properties = flat();
const withProperties: Tree = { properties };

/**
 * What a version changes. A version comes into being with its first change, from anyone, so not
 * even it has a map: its scope, the length of sections, and what it changes about clips, also
 * about each of their properties, each sit on their own.
 */
const version = flat({ sections: flat(), clips: flat({ [ANY]: flat({ properties }) }) });

/**
 * Which levels of a project are maps of their own in the Yjs document. Two people can change two
 * keys of a map at the same time and both changes stay. Everything below these levels is one
 * value: all keys of a property are one value, so a conflict is always about one property.
 */
const CONTAINERS: Tree = {
  manifest: fields,
  assets: flat(),
  notes: flat(),
  scenes: fields,
  sounds: fields,
  files: fields,
  /** The strings of a language, each on its own: a language has none until the first comes. */
  locales: { [ANY]: flat() },
  timelines: {
    [ANY]: {
      sections: { [ANY]: fields },
      tracks: { [ANY]: withProperties },
      clips: { [ANY]: withProperties },
      transitions: { [ANY]: fields },
      markers: { [ANY]: fields },
      overrides: { [ANY]: version },
    },
  },
};

function nodeAt(path: Path): Tree | undefined {
  let node: Tree | undefined = CONTAINERS;
  for (const key of path) {
    // An id can be anything, also a name that every object has.
    node = Object.hasOwn(node, key) ? node[key] : node[ANY];
    if (!node) return undefined;
  }
  return node;
}

/** Whether this path is a level of its own, as opposed to one value. */
export const isContainer = (path: Path): boolean => nodeAt(path) !== undefined;

/** Whether what this level holds sits in the nearest map above it. See `flat`. */
export const isFlat = (path: Path): boolean => {
  const node = nodeAt(path);
  return node !== undefined && FLAT.has(node);
};

const SEPARATOR = "/";

/** The key of a value of flat levels in the nearest map above them: its path from there. */
export const flatKey = (parts: Path): string => parts.join(SEPARATOR);

/**
 * Which value a key of the map at a path stands for, as its path from there, when it is the key of
 * a value of flat levels. In a map of its own only a flat level starts one, next to the fields. A
 * map that an older document has for a flat level holds nothing else. The last part is the rest of
 * the key, whatever it holds: the name of a string can have the separator in it, ids cannot.
 */
export function flatParts(path: Path, key: string): Path | undefined {
  const parts: string[] = [];
  let level = path;
  let rest = key;
  for (;;) {
    const index = rest.indexOf(SEPARATOR);
    const head = index < 0 ? undefined : rest.slice(0, index);
    if (head === undefined || !isFlat([...level, head])) break;
    parts.push(head);
    level = [...level, head];
    rest = rest.slice(index + 1);
  }
  // A level is no value. What stands for one is something an older document has, or nothing.
  if (!isFlat(level) || isFlat([...level, rest])) return undefined;
  return [...parts, rest];
}
