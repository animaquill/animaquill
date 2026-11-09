import {
  compileChannel,
  effectiveProperties,
  entryOf,
  type ClipChild,
  type ClipNode,
  type ClipState,
  type TreeNode,
} from "@animaquill/core";
import { isAnimation, type PropertyValue } from "@animaquill/schema";

/** The plain values of a property, with keys or without. */
const valuesOf = (value: PropertyValue) =>
  isAnimation(value) ? value.keys.map((key) => key.value) : [value];

/** A property that keys without an object can go to. */
export interface Connection {
  readonly path: string;
  /** Where it is in the tree, for people to tell it apart from another one of that name. */
  readonly label: string;
}

const kindOf = (path: string) => path.split(".", 1)[0];
const lastOf = (path: string) => path.slice(path.lastIndexOf(".") + 1);

/**
 * How likely it is that keys belong to a property: one of the same name on the same kind of thing is
 * what a rename leaves behind, and what is of another kind is the least likely.
 */
function closeness(from: string, to: string): number {
  const sameKind = kindOf(from) === kindOf(to);
  const sameName = lastOf(from) === lastOf(to);
  return (sameKind ? 2 : 0) + (sameName ? 1 : 0);
}

/**
 * Where the keys of a path that nothing describes can go: a property that something describes,
 * that holds nothing yet, and whose type can take what is there. What a rename most likely left
 * them for comes first, and otherwise they are in the order of the tree.
 */
export function connectionsFor(
  node: ClipNode,
  clip: ClipState,
  path: string,
  nameOf: (node: TreeNode) => string,
): readonly Connection[] {
  const properties = effectiveProperties(clip);
  const stored = entryOf(properties, path);
  if (stored === undefined) return [];
  const found: Connection[] = [];
  const visit = (child: ClipChild, above: readonly string[]) => {
    if (child.kind === "property") {
      const { spec } = child;
      if (spec.path === path || entryOf(properties, spec.path) !== undefined) return;
      if (compileChannel(stored, spec.type) === undefined) return;
      // Any text is a choice to a channel, but only one of its options is one to the property.
      if (
        spec.options &&
        !valuesOf(stored).every((value) => spec.options?.includes(value as string))
      )
        return;
      found.push({ path: spec.path, label: [...above, nameOf(child)].join(" › ") });
      return;
    }
    if (child.kind === "object" && (child.orphans || child.pending)) return;
    const names = [...above, nameOf(child)];
    for (const below of child.children) visit(below, names);
  };
  for (const child of node.children) visit(child, []);
  return found
    .map((connection, index) => ({ connection, index, score: closeness(path, connection.path) }))
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .map(({ connection }) => connection);
}
