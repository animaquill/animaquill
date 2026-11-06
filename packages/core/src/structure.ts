/** Where something is in a project: keys from the root down. */
export type Path = readonly string[];

type Tree = { readonly [key: string]: Tree };

const ANY = "*";
const fields: Tree = {};
/**
 * A level that not everything has from the start, such as the properties of a clip. Two people who
 * both make the first map of such a level end up with one of the two maps, and whatever is in the
 * other one is gone. So it has no map of its own: its entries sit in the map above it, each under a
 * key of its own. There is nothing to create, and two entries can never get in each other's way.
 *
 * Documents from before this have a map here. `ProjectStore` reads those too.
 */
const flat: Tree = {};
const withProperties: Tree = { properties: flat };

/**
 * Which levels of a project are maps of their own in the Yjs document. Two people can change two
 * keys of a map at the same time and both changes stay. Everything below these levels is one
 * value: all keys of a property are one value, so a conflict is always about one property.
 */
const CONTAINERS: Tree = {
  manifest: fields,
  assets: flat,
  notes: flat,
  scenes: fields,
  sounds: fields,
  files: fields,
  locales: { [ANY]: fields },
  timelines: {
    [ANY]: {
      sections: { [ANY]: fields },
      tracks: { [ANY]: withProperties },
      clips: { [ANY]: withProperties },
      transitions: { [ANY]: fields },
      markers: { [ANY]: fields },
      overrides: {
        [ANY]: { sections: fields, clips: { [ANY]: withProperties } },
      },
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

/** Whether the entries of this level sit in the map above it. See `flat`. */
export const isFlat = (path: Path): boolean => nodeAt(path) === flat;

const SEPARATOR = "/";

/** The key of an entry in the map above its level. */
export const flatKey = (level: string, entry: string): string => `${level}${SEPARATOR}${entry}`;

/** Which level and entry a key of the map at a path stands for, if that is what it is. */
export function flatEntry(path: Path, key: string): readonly [string, string] | undefined {
  const index = key.indexOf(SEPARATOR);
  if (index < 0) return undefined;
  const level = key.slice(0, index);
  return isFlat([...path, level]) ? [level, key.slice(index + 1)] : undefined;
}
