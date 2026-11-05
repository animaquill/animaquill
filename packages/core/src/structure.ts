/** Where something is in a project: keys from the root down. */
export type Path = readonly string[];

type Tree = { readonly [key: string]: Tree };

const ANY = "*";
const fields: Tree = {};
const withProperties: Tree = { properties: fields };

/**
 * Which levels of a project are maps of their own in the Yjs document. Two people can change two
 * keys of a map at the same time and both changes stay. Everything below these levels is one
 * value: all keys of a property are one value, so a conflict is always about one property.
 */
const CONTAINERS: Tree = {
  manifest: fields,
  assets: fields,
  notes: fields,
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
    node = node[key] ?? node[ANY];
    if (!node) return undefined;
  }
  return node;
}

/** Whether this path is a map in the document, as opposed to one value. */
export const isContainer = (path: Path): boolean => nodeAt(path) !== undefined;
